using System.Text.RegularExpressions;

namespace HubSpotDealsExporter;

public sealed class ConfigurationException(string message) : Exception(message);

/// <summary>
/// Reads settings from process environment variables first, then from the repository's
/// existing root .env file (the same file the NestJS API uses), so there is one source of truth.
/// Values are never printed.
/// </summary>
public sealed partial class ExporterSettings
{
    public const string TokenVariable = "HUBSPOT_ACCESS_TOKEN";
    public const string OrderPropertyVariable = "HUBSPOT_ORDER_ID_PROPERTY";

    public required string AccessToken { get; init; }
    public required string OrderIdProperty { get; init; }
    /// <summary>"environment" or the .env path; describes where the token came from without revealing it.</summary>
    public required string TokenSource { get; init; }

    public static ExporterSettings Load(Func<string, string?> environment, IEnumerable<string?> searchDirectories)
    {
        var envFile = FindEnvFile(searchDirectories);
        var fileValues = envFile is null ? new Dictionary<string, string>() : ParseEnvFile(File.ReadAllLines(envFile));

        string? Lookup(string name, out string source)
        {
            var value = environment(name);
            if (!string.IsNullOrWhiteSpace(value)) { source = "environment"; return value.Trim(); }
            if (fileValues.TryGetValue(name, out var fromFile) && !string.IsNullOrWhiteSpace(fromFile)) { source = envFile!; return fromFile.Trim(); }
            source = "";
            return null;
        }

        var token = Lookup(TokenVariable, out var tokenSource)
            ?? throw new ConfigurationException(TokenVariable + " is not set. Set it as an environment variable or in the repository's root .env file.");
        if (token.Length < 8 || token.Length > 2048 || token.Any(c => char.IsWhiteSpace(c) || char.IsControl(c)))
        {
            throw new ConfigurationException(TokenVariable + " is malformed (unexpected length or whitespace). Check the configured value.");
        }

        var property = Lookup(OrderPropertyVariable, out _) ?? "optima_order_id";
        if (!PropertyName().IsMatch(property))
        {
            throw new ConfigurationException(OrderPropertyVariable + " must be a HubSpot internal property name such as optima_order_id.");
        }

        return new ExporterSettings { AccessToken = token, OrderIdProperty = property, TokenSource = tokenSource };
    }

    /// <summary>Nearest .env walking up from each start directory, in order.</summary>
    public static string? FindEnvFile(IEnumerable<string?> searchDirectories)
    {
        foreach (var start in searchDirectories)
        {
            if (string.IsNullOrWhiteSpace(start)) continue;
            for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            {
                var candidate = Path.Combine(dir.FullName, ".env");
                if (File.Exists(candidate)) return candidate;
            }
        }
        return null;
    }

    /// <summary>Minimal dotenv parser: KEY=VALUE, optional "export ", quotes, and # comments.</summary>
    public static Dictionary<string, string> ParseEnvFile(IEnumerable<string> lines)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var raw in lines)
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;
            if (line.StartsWith("export ", StringComparison.Ordinal)) line = line[7..].TrimStart();
            var equals = line.IndexOf('=');
            if (equals <= 0) continue;
            var key = line[..equals].Trim();
            var value = line[(equals + 1)..].Trim();
            if (value.Length >= 2 && (value[0] == '"' || value[0] == '\'') && value[^1] == value[0])
            {
                value = value[1..^1];
            }
            else
            {
                var comment = value.IndexOf(" #", StringComparison.Ordinal);
                if (comment >= 0) value = value[..comment].TrimEnd();
            }
            values[key] = value; // later lines win, like dotenv
        }
        return values;
    }

    [GeneratedRegex("^[a-z][a-z0-9_]*$")]
    private static partial Regex PropertyName();
}
