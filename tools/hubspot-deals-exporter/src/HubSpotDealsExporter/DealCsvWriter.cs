using System.Globalization;
using System.Text;

namespace HubSpotDealsExporter;

/// <summary>
/// RFC 4180 CSV: comma separator, CRLF rows, fields quoted when they contain a comma, quote,
/// CR or LF, with embedded quotes doubled. UTF-8 with BOM so Excel detects the encoding.
/// </summary>
public static class DealCsvWriter
{
    public static readonly string[] Header =
        ["Deal ID", "Deal Name", "Amount", "Currency", "Pipeline ID", "Deal Stage ID", "Created At (UTC)", "Close Date (UTC)", "Optima Order ID"];

    public static string[] ToRow(Deal deal) =>
    [
        deal.Id,
        Neutralize(deal.Name),
        // Amounts are copied exactly as HubSpot returned them (no parsing, rounding or conversion).
        IsPlainNumber(deal.Amount) ? deal.Amount! : Neutralize(deal.Amount),
        Neutralize(deal.Currency),
        Neutralize(deal.PipelineId),
        Neutralize(deal.StageId),
        FormatUtc(deal.CreatedAtUtc),
        FormatDate(deal.CloseDate),
        Neutralize(deal.OrderId),
    ];

    public static string FormatUtc(DateTimeOffset value) =>
        value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    /// <summary>HubSpot date-times become ISO 8601 UTC; anything unparseable is kept (neutralized) rather than lost.</summary>
    public static string FormatDate(string? value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        return DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed)
            ? FormatUtc(parsed)
            : Neutralize(value);
    }

    /// <summary>
    /// Spreadsheet formula injection guard (OWASP): text starting with = + - @ tab or CR is
    /// prefixed with an apostrophe so Excel/Sheets show it as text instead of evaluating it.
    /// </summary>
    public static string Neutralize(string? value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        return value[0] is '=' or '+' or '-' or '@' or '\t' or '\r' ? "'" + value : value;
    }

    /// <summary>Invariant decimal such as "900", "-12.5" or "1250.00"; such values are safe and left untouched.</summary>
    public static bool IsPlainNumber(string? value) =>
        !string.IsNullOrEmpty(value)
        && decimal.TryParse(value, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out _);

    public static string Escape(string? field)
    {
        if (string.IsNullOrEmpty(field)) return "";
        return field.IndexOfAny([',', '"', '\r', '\n']) >= 0 ? "\"" + field.Replace("\"", "\"\"") + "\"" : field;
    }

    public static string FormatLine(IEnumerable<string?> fields) => string.Join(",", fields.Select(Escape));

    public static string Render(IEnumerable<Deal> deals)
    {
        var builder = new StringBuilder();
        builder.Append(FormatLine(Header)).Append("\r\n");
        foreach (var deal in deals) builder.Append(FormatLine(ToRow(deal))).Append("\r\n");
        return builder.ToString();
    }

    /// <summary>Creates the directory if needed and writes atomically (temp file + rename), so a failure never leaves a partial CSV.</summary>
    public static async Task WriteAsync(string path, IEnumerable<Deal> deals, CancellationToken cancellationToken = default)
    {
        var fullPath = Path.GetFullPath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        var temp = fullPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllTextAsync(temp, Render(deals), new UTF8Encoding(encoderShouldEmitUTF8Identifier: true), cancellationToken);
            File.Move(temp, fullPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }
}
