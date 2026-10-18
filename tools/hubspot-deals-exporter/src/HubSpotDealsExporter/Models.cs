namespace HubSpotDealsExporter;

/// <summary>
/// Half-open UTC window: Start &lt;= createdate &lt; End, compared at millisecond precision
/// (HubSpot's timestamp resolution). Consecutive windows therefore never overlap.
/// </summary>
public sealed record ExportWindow(DateTimeOffset StartUtc, DateTimeOffset EndUtc)
{
    /// <summary>End is captured once, so every page of one export uses the same window.</summary>
    public static ExportWindow LastDays(TimeProvider time, int days = 7)
    {
        var end = time.GetUtcNow();
        // Whole milliseconds, so the printed window matches the filter sent to HubSpot exactly.
        end = DateTimeOffset.FromUnixTimeMilliseconds(end.ToUnixTimeMilliseconds());
        return new ExportWindow(end.AddDays(-days), end); // UTC has no DST: always exactly days × 24 h
    }

    public long StartMs => StartUtc.ToUnixTimeMilliseconds();
    public long EndMs => EndUtc.ToUnixTimeMilliseconds();

    public bool Contains(DateTimeOffset createdAt)
    {
        var ms = createdAt.ToUnixTimeMilliseconds();
        return ms >= StartMs && ms < EndMs;
    }
}

/// <summary>A Deal as returned by HubSpot. Optional properties stay exactly as HubSpot sent them.</summary>
public sealed record Deal(
    string Id,
    DateTimeOffset CreatedAtUtc,
    string? Name,
    string? Amount,
    string? Currency,
    string? PipelineId,
    string? StageId,
    string? CloseDate,
    string? OrderId);

public sealed record DealSearchResult(IReadOnlyList<Deal> Deals, int Pages, int DuplicatesSkipped, int OutsideWindowSkipped);

public sealed record RetryPolicy(int MaxAttempts, TimeSpan InitialDelay, double Multiplier, TimeSpan MaxDelay)
{
    /// <summary>Same defaults as the NestJS integration: 5 tries, 1 s → 30 s.</summary>
    public static RetryPolicy Default { get; } = new(5, TimeSpan.FromSeconds(1), 2, TimeSpan.FromSeconds(30));

    /// <summary>
    /// Delay before retry n (1 = first retry), "equal jitter":
    /// cap = min(MaxDelay, InitialDelay × Multiplier^(n−1)); delay is uniform in [cap/2, cap].
    /// </summary>
    public TimeSpan BackoffDelay(int retry, double random)
    {
        var capMs = Math.Min(MaxDelay.TotalMilliseconds, InitialDelay.TotalMilliseconds * Math.Pow(Multiplier, Math.Max(0, retry - 1)));
        var r = Math.Clamp(random, 0, 1);
        return TimeSpan.FromMilliseconds(Math.Round(capMs / 2 + r * capMs / 2));
    }
}

public enum HubSpotErrorKind { Authentication, Permission, Transient, InvalidResponse, Pagination, RequestFailed }

/// <summary>Messages never include response bodies or the access token.</summary>
public sealed class HubSpotExportException(HubSpotErrorKind kind, string message, int? status = null) : Exception(message)
{
    public HubSpotErrorKind Kind { get; } = kind;
    public int? Status { get; } = status;
}
