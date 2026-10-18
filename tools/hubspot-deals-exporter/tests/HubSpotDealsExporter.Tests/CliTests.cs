using System.Net.Http.Headers;
using HubSpotDealsExporter;

namespace HubSpotDealsExporter.Tests;

public class CliTests
{
    private sealed record Run(int ExitCode, string Stdout, string Stderr, StubHandler Handler);

    private static async Task<Run> RunCli(TempDir dir, string[] args, string? token = Hub.Token,
        params Func<RecordedRequest, CancellationToken, Task<HttpResponseMessage>>[] script)
    {
        var handler = new StubHandler(script.Length > 0 ? script : [Hub.Page(null, Hub.Deal("42", Hub.Now.AddDays(-2)))]);
        var environment = new CliEnvironment(
            name => name == "HUBSPOT_ACCESS_TOKEN" ? token : null,
            new FakeTime(Hub.Now), dir.Path, dir.Path, handler,
            Delay: (_, _) => Task.CompletedTask, Random: () => 0.5);
        var stdout = new StringWriter(); var stderr = new StringWriter();
        var code = await Cli.RunAsync(args, stdout, stderr, environment);
        return new Run(code, stdout.ToString(), stderr.ToString(), handler);
    }

    [Fact]
    public async Task Default_run_writes_dated_csv_under_output_and_exits_zero()
    {
        using var dir = new TempDir();
        var run = await RunCli(dir, []);
        Assert.Equal(ExitCodes.Success, run.ExitCode);
        var path = Path.Combine(dir.Path, "output", "hubspot-deals-2026-10-18.csv");
        Assert.True(File.Exists(path));
        Assert.Contains("Exported 1 deal(s) from 1 page(s) to " + path, run.Stdout);
        Assert.Contains("2026-10-11T12:00:00.000Z (inclusive) to 2026-10-18T12:00:00.000Z (exclusive)", run.Stdout);
        var lines = File.ReadAllText(path).Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(2, lines.Length);
        Assert.StartsWith("42,Order 42,900,PHP,", lines[1]);
    }

    [Fact]
    public void Default_output_is_next_to_the_solution_when_found()
    {
        using var dir = new TempDir();
        var root = dir.Sub(Path.Combine("tools", "hubspot-deals-exporter"));
        File.WriteAllText(Path.Combine(root, "HubSpotDealsExporter.sln"), "");
        var environment = new CliEnvironment(_ => null, new FakeTime(Hub.Now), dir.Path, Path.Combine(root, "src", "bin"));
        var window = ExportWindow.LastDays(environment.Time);
        Assert.Equal(Path.Combine(root, "output", "hubspot-deals-2026-10-18.csv"), Cli.ResolveOutputPath(null, window, environment));
    }

    [Theory]
    [InlineData("--output")]
    [InlineData("-o")]
    public async Task Custom_output_file_creates_missing_directories(string flag)
    {
        using var dir = new TempDir();
        var run = await RunCli(dir, [flag, Path.Combine("exports", "2026", "deals.csv")]);
        Assert.Equal(ExitCodes.Success, run.ExitCode);
        Assert.True(File.Exists(Path.Combine(dir.Path, "exports", "2026", "deals.csv")));
    }

    [Fact]
    public async Task Output_equals_syntax_and_directory_target_are_supported()
    {
        using var dir = new TempDir();
        var target = dir.Sub("existing");
        var run = await RunCli(dir, ["--output=" + target]);
        Assert.Equal(ExitCodes.Success, run.ExitCode);
        Assert.True(File.Exists(Path.Combine(target, "hubspot-deals-2026-10-18.csv")));
    }

    [Theory]
    [InlineData("--help")]
    [InlineData("-h")]
    public async Task Help_prints_usage_without_contacting_hubspot(string flag)
    {
        using var dir = new TempDir();
        var run = await RunCli(dir, [flag], token: null);
        Assert.Equal(ExitCodes.Success, run.ExitCode);
        Assert.Contains("Usage:", run.Stdout);
        Assert.Empty(run.Handler.Requests);
    }

    [Theory]
    [InlineData("--bogus")]
    [InlineData("--output")]
    [InlineData("--output=")]
    public async Task Invalid_arguments_exit_with_usage_code(string arg)
    {
        using var dir = new TempDir();
        var run = await RunCli(dir, [arg]);
        Assert.Equal(ExitCodes.Usage, run.ExitCode);
        Assert.Contains("--help", run.Stderr);
        Assert.Empty(run.Handler.Requests);
    }

    [Fact]
    public async Task Duplicate_output_option_is_rejected()
    {
        using var dir = new TempDir();
        Assert.Equal(ExitCodes.Usage, (await RunCli(dir, ["-o", "a.csv", "--output", "b.csv"])).ExitCode);
    }

    [Fact]
    public async Task Missing_token_exits_with_configuration_code_and_writes_nothing()
    {
        using var dir = new TempDir();
        var run = await RunCli(dir, [], token: null);
        Assert.Equal(ExitCodes.Configuration, run.ExitCode);
        Assert.Contains("HUBSPOT_ACCESS_TOKEN is not set", run.Stderr);
        Assert.Empty(run.Handler.Requests);
        Assert.False(Directory.Exists(Path.Combine(dir.Path, "output")));
    }

    [Theory]
    [InlineData(401, "HTTP 401")]
    [InlineData(403, "crm.objects.deals.read")]
    public async Task Access_denied_exits_with_code_4(int status, string message)
    {
        using var dir = new TempDir();
        var run = await RunCli(dir, [], script: Hub.Status(status));
        Assert.Equal(ExitCodes.AccessDenied, run.ExitCode);
        Assert.Contains(message, run.Stderr);
        Assert.Single(run.Handler.Requests);
        Assert.False(Directory.Exists(Path.Combine(dir.Path, "output")));
    }

    [Fact]
    public async Task Exhausted_retries_exit_with_code_1_and_no_partial_file()
    {
        using var dir = new TempDir();
        var run = await RunCli(dir, [], script: [Hub.Page("100", Hub.Deal("1", Hub.Now.AddDays(-1))), Hub.Status(503)]);
        Assert.Equal(ExitCodes.ExportFailed, run.ExitCode);
        Assert.Contains("gave up after 5 attempts", run.Stderr);
        Assert.False(Directory.Exists(Path.Combine(dir.Path, "output")));
    }

    [Fact]
    public async Task Unwritable_output_exits_with_code_1()
    {
        using var dir = new TempDir();
        var blocker = Path.Combine(dir.Path, "file-not-dir");
        File.WriteAllText(blocker, "");
        var run = await RunCli(dir, ["-o", Path.Combine(blocker, "deals.csv")]);
        Assert.Equal(ExitCodes.ExportFailed, run.ExitCode);
        Assert.Contains("could not write", run.Stderr);
    }

    [Fact]
    public async Task Token_never_appears_in_output_errors_or_csv()
    {
        using var dir = new TempDir();
        var runs = new List<Run>
        {
            await RunCli(dir, []),
            await RunCli(dir, [], script: Hub.Status(401)),
            await RunCli(dir, [], script: Hub.Status(403)),
            await RunCli(dir, [], script: Hub.Status(500)),
            await RunCli(dir, [], script: Hub.Status(429, r => r.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(600)))),
            await RunCli(dir, [], script: Hub.Json("not json")),
        };
        foreach (var run in runs)
        {
            Assert.DoesNotContain(Hub.Token, run.Stdout);
            Assert.DoesNotContain(Hub.Token, run.Stderr);
            Assert.All(run.Handler.Requests, r => Assert.Equal("Bearer " + Hub.Token, r.Authorization));
            Assert.All(run.Handler.Requests, r => Assert.DoesNotContain(Hub.Token, r.Body!.ToJsonString()));
        }
        Assert.Contains("Token source: environment variable", runs[0].Stdout);
        foreach (var file in Directory.GetFiles(dir.Path, "*.csv", SearchOption.AllDirectories))
        {
            Assert.DoesNotContain(Hub.Token, File.ReadAllText(file));
        }
    }

    [Fact]
    public async Task Exporter_only_ever_issues_the_read_only_search_call()
    {
        using var dir = new TempDir();
        var run = await RunCli(dir, [], script: [Hub.Page("100", Hub.Deal("1", Hub.Now.AddDays(-1))), Hub.Page(null, Hub.Deal("2", Hub.Now.AddDays(-1)))]);
        Assert.Equal(ExitCodes.Success, run.ExitCode);
        Assert.All(run.Handler.Requests, r => Assert.Equal(("POST", "/crm/v3/objects/deals/search"), (r.Method.Method, r.Path)));
    }
}
