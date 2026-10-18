using System.Globalization;

namespace HubSpotDealsExporter;

public static class ExitCodes
{
    public const int Success = 0;
    public const int ExportFailed = 1;   // HubSpot temporary/unknown failure, invalid response, file I/O
    public const int Usage = 2;          // invalid command-line arguments
    public const int Configuration = 3;  // missing or malformed settings
    public const int AccessDenied = 4;   // HTTP 401 / 403
}

/// <summary>Everything the CLI touches from the outside world, injectable for tests.</summary>
public sealed record CliEnvironment(
    Func<string, string?> GetVariable,
    TimeProvider Time,
    string WorkingDirectory,
    string BaseDirectory,
    HttpMessageHandler? Handler = null,
    Func<TimeSpan, CancellationToken, Task>? Delay = null,
    Func<double>? Random = null)
{
    public static CliEnvironment System() =>
        new(Environment.GetEnvironmentVariable, TimeProvider.System, Directory.GetCurrentDirectory(), AppContext.BaseDirectory);
}

public static class Cli
{
    public const string Usage = """
        HubSpot Deals CSV exporter (read-only)

        Exports every HubSpot Deal whose createdate falls in the last 7 days
        (UTC, start inclusive, end exclusive) to a UTF-8 CSV file.

        Usage:
          dotnet run --project tools/hubspot-deals-exporter/src/HubSpotDealsExporter -- [options]

        Options:
          -o, --output <path>  CSV file to write, or an existing directory / path ending in a
                               separator to use the default file name inside it.
                               Default: tools/hubspot-deals-exporter/output/hubspot-deals-<UTC date>.csv
          -h, --help           Show this help.

        Configuration:
          HUBSPOT_ACCESS_TOKEN       Private app token (crm.objects.deals.read). Read from the
                                     environment, else from the repository root .env file.
          HUBSPOT_ORDER_ID_PROPERTY  Deal property for the Optima order ID (default optima_order_id).

        Exit codes: 0 success, 1 export failed, 2 invalid arguments, 3 configuration error,
                    4 HubSpot denied access (401/403).
        """;

    public static async Task<int> RunAsync(string[] args, TextWriter stdout, TextWriter stderr, CliEnvironment environment, CancellationToken cancellationToken = default)
    {
        string? output = null;
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (arg is "-h" or "--help" or "/?") { await stdout.WriteLineAsync(Usage); return ExitCodes.Success; }
            if (arg is "-o" or "--output")
            {
                if (output is not null) return await UsageError(stderr, "--output was given more than once.");
                if (i + 1 >= args.Length || string.IsNullOrWhiteSpace(args[i + 1])) return await UsageError(stderr, "--output requires a path.");
                output = args[++i];
            }
            else if (arg.StartsWith("--output=", StringComparison.Ordinal))
            {
                if (output is not null) return await UsageError(stderr, "--output was given more than once.");
                output = arg["--output=".Length..];
                if (string.IsNullOrWhiteSpace(output)) return await UsageError(stderr, "--output requires a path.");
            }
            else
            {
                return await UsageError(stderr, "Unknown argument: " + arg);
            }
        }

        ExporterSettings settings;
        try
        {
            settings = ExporterSettings.Load(environment.GetVariable, [environment.BaseDirectory, environment.WorkingDirectory]);
        }
        catch (ConfigurationException error)
        {
            await stderr.WriteLineAsync("Configuration error: " + error.Message);
            return ExitCodes.Configuration;
        }

        var window = ExportWindow.LastDays(environment.Time);
        var path = ResolveOutputPath(output, window, environment);
        await stdout.WriteLineAsync("Token source: " + (settings.TokenSource == "environment" ? "environment variable" : settings.TokenSource));
        await stdout.WriteLineAsync("Exporting Deals created from " + DealCsvWriter.FormatUtc(window.StartUtc) + " (inclusive) to " + DealCsvWriter.FormatUtc(window.EndUtc) + " (exclusive)...");

        try
        {
            var handler = environment.Handler ?? new SocketsHttpHandler { AllowAutoRedirect = false, PooledConnectionLifetime = TimeSpan.FromMinutes(5) };
            using var http = new HttpClient(handler, disposeHandler: environment.Handler is null)
            {
                BaseAddress = new Uri("https://api.hubapi.com"),
                Timeout = Timeout.InfiniteTimeSpan, // per-request timeouts are enforced by the client
            };
            var client = new HubSpotDealsClient(http, settings.AccessToken, environment.Time, delay: environment.Delay, random: environment.Random);
            var result = await client.SearchDealsCreatedAsync(window, settings.OrderIdProperty, cancellationToken);
            await DealCsvWriter.WriteAsync(path, result.Deals, cancellationToken);

            await stdout.WriteLineAsync("Exported " + result.Deals.Count.ToString(CultureInfo.InvariantCulture) + " deal(s) from " +
                result.Pages.ToString(CultureInfo.InvariantCulture) + " page(s) to " + path);
            if (result.DuplicatesSkipped > 0) await stdout.WriteLineAsync("Skipped " + result.DuplicatesSkipped + " duplicate Deal ID(s) returned across pages.");
            if (result.OutsideWindowSkipped > 0) await stdout.WriteLineAsync("Skipped " + result.OutsideWindowSkipped + " Deal(s) outside the window.");
            return ExitCodes.Success;
        }
        catch (HubSpotExportException error)
        {
            await stderr.WriteLineAsync("Export failed: " + error.Message);
            return error.Kind is HubSpotErrorKind.Authentication or HubSpotErrorKind.Permission ? ExitCodes.AccessDenied : ExitCodes.ExportFailed;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        {
            await stderr.WriteLineAsync("Export failed: could not write " + path + " (" + error.GetType().Name + ").");
            return ExitCodes.ExportFailed;
        }
    }

    public static string DefaultFileName(ExportWindow window) =>
        "hubspot-deals-" + window.EndUtc.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + ".csv";

    public static string ResolveOutputPath(string? output, ExportWindow window, CliEnvironment environment)
    {
        if (output is null) return Path.Combine(ExporterRoot(environment), "output", DefaultFileName(window));
        var path = Path.GetFullPath(output, environment.WorkingDirectory);
        var isDirectory = Directory.Exists(path) || output.EndsWith(Path.DirectorySeparatorChar) || output.EndsWith(Path.AltDirectorySeparatorChar);
        return isDirectory ? Path.Combine(path, DefaultFileName(window)) : path;
    }

    /// <summary>The folder containing HubSpotDealsExporter.sln, found from the build output; falls back to the working directory.</summary>
    public static string ExporterRoot(CliEnvironment environment)
    {
        foreach (var start in new[] { environment.BaseDirectory, environment.WorkingDirectory })
        {
            for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            {
                if (File.Exists(Path.Combine(dir.FullName, "HubSpotDealsExporter.sln"))) return dir.FullName;
                var nested = Path.Combine(dir.FullName, "tools", "hubspot-deals-exporter");
                if (File.Exists(Path.Combine(nested, "HubSpotDealsExporter.sln"))) return nested;
            }
        }
        return environment.WorkingDirectory;
    }

    private static async Task<int> UsageError(TextWriter stderr, string message)
    {
        await stderr.WriteLineAsync(message);
        await stderr.WriteLineAsync("Run with --help for usage.");
        return ExitCodes.Usage;
    }
}
