using HubSpotDealsExporter;

namespace HubSpotDealsExporter.Tests;

public sealed class TempDir : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "deals-export-tests", Guid.NewGuid().ToString("N"));
    public TempDir() => Directory.CreateDirectory(Path);
    public string Sub(string name) { var p = System.IO.Path.Combine(Path, name); Directory.CreateDirectory(p); return p; }
    public void Dispose() { try { Directory.Delete(Path, recursive: true); } catch (IOException) { } }
}

public class ExporterSettingsTests
{
    private static Func<string, string?> Env(params (string Key, string Value)[] values) =>
        name => values.FirstOrDefault(v => v.Key == name).Value;

    [Fact]
    public void Environment_variable_wins_over_env_file()
    {
        using var dir = new TempDir();
        File.WriteAllText(Path.Combine(dir.Path, ".env"), "HUBSPOT_ACCESS_TOKEN=file-token-123456\n");
        var settings = ExporterSettings.Load(Env(("HUBSPOT_ACCESS_TOKEN", "env-token-123456")), [dir.Path]);
        Assert.Equal("env-token-123456", settings.AccessToken);
        Assert.Equal("environment", settings.TokenSource);
        Assert.Equal("optima_order_id", settings.OrderIdProperty);
    }

    [Fact]
    public void Reads_the_nearest_parent_env_file()
    {
        using var dir = new TempDir();
        File.WriteAllText(Path.Combine(dir.Path, ".env"),
            "# comment\nexport HUBSPOT_ACCESS_TOKEN=\"quoted-token-123456\"\nHUBSPOT_ORDER_ID_PROPERTY=custom_order_ref # inline\nDB_PASSWORD=ignored\n");
        var nested = dir.Sub(Path.Combine("tools", "hubspot-deals-exporter", "bin"));
        var settings = ExporterSettings.Load(Env(), [nested]);
        Assert.Equal("quoted-token-123456", settings.AccessToken);
        Assert.Equal("custom_order_ref", settings.OrderIdProperty);
        Assert.Equal(Path.Combine(dir.Path, ".env"), settings.TokenSource);
    }

    [Fact]
    public void Missing_token_is_a_configuration_error()
    {
        using var dir = new TempDir();
        var error = Assert.Throws<ConfigurationException>(() => ExporterSettings.Load(Env(), [dir.Path]));
        Assert.Contains("HUBSPOT_ACCESS_TOKEN is not set", error.Message);
    }

    [Theory]
    [InlineData("short")]
    [InlineData("has space inside-123")]
    public void Malformed_token_is_rejected_without_echoing_it(string token)
    {
        using var dir = new TempDir();
        var error = Assert.Throws<ConfigurationException>(() => ExporterSettings.Load(Env(("HUBSPOT_ACCESS_TOKEN", token)), [dir.Path]));
        Assert.DoesNotContain(token, error.Message);
    }

    [Theory]
    [InlineData("Optima Order")]
    [InlineData("1abc")]
    [InlineData("drop;table")]
    public void Invalid_order_property_is_rejected(string property)
    {
        using var dir = new TempDir();
        Assert.Throws<ConfigurationException>(() =>
            ExporterSettings.Load(Env(("HUBSPOT_ACCESS_TOKEN", Hub.Token), ("HUBSPOT_ORDER_ID_PROPERTY", property)), [dir.Path]));
    }

    [Fact]
    public void Env_parser_handles_blank_lines_quotes_and_last_value_wins()
    {
        var values = ExporterSettings.ParseEnvFile(["", "A=1", "B='two words'", "A=3", "NOEQUALS", "=novalue", "C=x#notcomment"]);
        Assert.Equal("3", values["A"]);
        Assert.Equal("two words", values["B"]);
        Assert.Equal("x#notcomment", values["C"]);
        Assert.False(values.ContainsKey("NOEQUALS"));
    }
}
