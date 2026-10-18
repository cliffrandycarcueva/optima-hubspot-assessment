using System.Text;
using HubSpotDealsExporter;

namespace HubSpotDealsExporter.Tests;

public class DealCsvWriterTests
{
    private static Deal Deal(string? name = "Order 1", string? amount = "900", string? close = "2026-09-20T06:32:00Z", string? orderId = "ORD-1") =>
        new("1", new DateTimeOffset(2026, 10, 17, 8, 30, 15, 123, TimeSpan.Zero), name, amount, "PHP", "default", "appointmentscheduled", close, orderId);

    /// <summary>Minimal RFC 4180 reader used to prove rows round-trip and stay aligned.</summary>
    private static List<List<string>> Parse(string csv)
    {
        var rows = new List<List<string>>(); var row = new List<string>(); var field = new StringBuilder();
        var quoted = false;
        for (var i = 0; i < csv.Length; i++)
        {
            var c = csv[i];
            if (quoted)
            {
                if (c == '"' && i + 1 < csv.Length && csv[i + 1] == '"') { field.Append('"'); i++; }
                else if (c == '"') quoted = false;
                else field.Append(c);
            }
            else if (c == '"') quoted = true;
            else if (c == ',') { row.Add(field.ToString()); field.Clear(); }
            else if (c == '\r' && i + 1 < csv.Length && csv[i + 1] == '\n') { row.Add(field.ToString()); field.Clear(); rows.Add(row); row = []; i++; }
            else field.Append(c);
        }
        return rows;
    }

    [Fact]
    public void Header_and_row_use_expected_columns_and_formats()
    {
        var csv = DealCsvWriter.Render([Deal()]);
        Assert.Equal(
            "Deal ID,Deal Name,Amount,Currency,Pipeline ID,Deal Stage ID,Created At (UTC),Close Date (UTC),Optima Order ID\r\n" +
            "1,Order 1,900,PHP,default,appointmentscheduled,2026-10-17T08:30:15.123Z,2026-09-20T06:32:00.000Z,ORD-1\r\n", csv);
    }

    [Fact]
    public void Empty_export_still_has_header()
    {
        Assert.Equal(string.Join(",", DealCsvWriter.Header) + "\r\n", DealCsvWriter.Render([]));
    }

    [Theory]
    [InlineData("plain", "plain")]
    [InlineData("Smith, Maria", "\"Smith, Maria\"")]
    [InlineData("The \"Big\" order", "\"The \"\"Big\"\" order\"")]
    [InlineData("line1\nline2", "\"line1\nline2\"")]
    [InlineData("line1\r\nline2", "\"line1\r\nline2\"")]
    [InlineData("", "")]
    [InlineData(null, "")]
    public void Fields_are_escaped_per_rfc4180(string? input, string expected)
    {
        Assert.Equal(expected, DealCsvWriter.Escape(input));
    }

    [Fact]
    public void Commas_quotes_and_newlines_round_trip_with_aligned_rows()
    {
        var tricky = "Acme, \"Rush\"\r\norder\nline 3";
        var csv = DealCsvWriter.Render([Deal(name: tricky), Deal(name: "Second")]);
        var rows = Parse(csv);
        Assert.Equal(3, rows.Count);
        Assert.All(rows, r => Assert.Equal(DealCsvWriter.Header.Length, r.Count));
        Assert.Equal(tricky, rows[1][1]);
        Assert.Equal("Second", rows[2][1]);
    }

    [Theory]
    [InlineData("=HYPERLINK(\"http://x\")", "'=HYPERLINK(\"http://x\")")]
    [InlineData("+1+1", "'+1+1")]
    [InlineData("-2+3", "'-2+3")]
    [InlineData("@SUM(A1)", "'@SUM(A1)")]
    [InlineData("\tcmd", "'\tcmd")]
    [InlineData("\rcmd", "'\rcmd")]
    [InlineData("Order =1", "Order =1")]
    public void Formula_injection_is_neutralized(string input, string expected)
    {
        Assert.Equal(expected, DealCsvWriter.Neutralize(input));
        var row = DealCsvWriter.ToRow(Deal(name: input, orderId: input));
        Assert.Equal(expected, row[1]);
        Assert.Equal(expected, row[8]);
    }

    [Theory]
    [InlineData("900", "900")]
    [InlineData("900.00", "900.00")]
    [InlineData("-50.5", "-50.5")]
    [InlineData("1250.123456", "1250.123456")]
    [InlineData("=1+2", "'=1+2")]
    [InlineData(null, "")]
    public void Amounts_are_kept_verbatim_and_never_reformatted(string? amount, string expected)
    {
        Assert.Equal(expected, DealCsvWriter.ToRow(Deal(amount: amount))[2]);
    }

    [Fact]
    public void Missing_optional_values_become_empty_cells()
    {
        var deal = new Deal("9", new DateTimeOffset(2026, 10, 17, 0, 0, 0, TimeSpan.Zero), null, null, null, null, null, null, null);
        Assert.Equal("9,,,,,,2026-10-17T00:00:00.000Z,,", DealCsvWriter.FormatLine(DealCsvWriter.ToRow(deal)));
    }

    [Theory]
    [InlineData("2026-09-20T14:32:00+08:00", "2026-09-20T06:32:00.000Z")]
    [InlineData("2026-09-20T06:32:00.5Z", "2026-09-20T06:32:00.500Z")]
    [InlineData("2026-09-20", "2026-09-20T00:00:00.000Z")]
    [InlineData("not a date", "not a date")]
    [InlineData("=evil()", "'=evil()")]
    [InlineData("", "")]
    public void Close_dates_are_normalized_to_iso_8601_utc(string input, string expected)
    {
        Assert.Equal(expected, DealCsvWriter.FormatDate(input));
    }

    [Fact]
    public async Task Writes_utf8_with_bom_creating_missing_directories_atomically()
    {
        var dir = Path.Combine(Path.GetTempPath(), "deals-export-tests", Guid.NewGuid().ToString("N"), "nested", "output");
        var path = Path.Combine(dir, "deals.csv");
        try
        {
            await DealCsvWriter.WriteAsync(path, [Deal(name: "Peña ₱ order")]);
            var bytes = await File.ReadAllBytesAsync(path);
            Assert.Equal(new byte[] { 0xEF, 0xBB, 0xBF }, bytes[..3]);
            Assert.Contains("Peña ₱ order", Encoding.UTF8.GetString(bytes));
            Assert.Equal(["deals.csv"], Directory.GetFiles(dir).Select(Path.GetFileName));
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(dir))!, recursive: true);
        }
    }
}
