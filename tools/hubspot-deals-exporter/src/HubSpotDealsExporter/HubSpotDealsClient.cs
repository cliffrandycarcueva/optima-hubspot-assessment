using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace HubSpotDealsExporter;

/// <summary>
/// Read-only client for POST /crm/v3/objects/deals/search (a query endpoint; it never writes).
/// Requires the crm.objects.deals.read scope.
/// </summary>
public sealed class HubSpotDealsClient(
    HttpClient http,
    string accessToken,
    TimeProvider time,
    RetryPolicy? retry = null,
    Func<TimeSpan, CancellationToken, Task>? delay = null,
    Func<double>? random = null,
    TimeSpan? requestTimeout = null,
    TimeSpan? pageDelay = null)
{
    public const string SearchPath = "/crm/v3/objects/deals/search";
    public const int PageSize = 100;
    /// <summary>HubSpot search cannot page past 10,000 results for one query.</summary>
    public const int SearchResultCap = 10000;
    private const int MaxPages = 5000;

    private readonly RetryPolicy retryPolicy = retry ?? RetryPolicy.Default;
    private readonly Func<TimeSpan, CancellationToken, Task> sleep = delay ?? ((d, ct) => Task.Delay(d, ct));
    private readonly Func<double> jitter = random ?? Random.Shared.NextDouble;
    private readonly TimeSpan timeout = requestTimeout ?? TimeSpan.FromSeconds(30);
    // The search API allows ~5 requests/second per account; a small gap avoids self-inflicted 429s.
    private readonly TimeSpan pageGap = pageDelay ?? TimeSpan.FromMilliseconds(250);

    public static string[] RequestedProperties(string orderIdProperty) =>
        ["dealname", "amount", "deal_currency_code", "pipeline", "dealstage", "createdate", "closedate", orderIdProperty];

    public async Task<DealSearchResult> SearchDealsCreatedAsync(ExportWindow window, string orderIdProperty, CancellationToken cancellationToken = default)
    {
        var deals = new List<Deal>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var properties = RequestedProperties(orderIdProperty);
        long lowerBoundMs = window.StartMs, lastCreatedMs = window.StartMs;
        string? after = null;
        int pages = 0, duplicates = 0, outside = 0;

        while (true)
        {
            if (pages > 0) await sleep(pageGap, cancellationToken);
            if (++pages > MaxPages) throw new HubSpotExportException(HubSpotErrorKind.Pagination, "Pagination did not finish after " + MaxPages + " pages.");

            using var document = await SendWithRetryAsync(BuildSearchBody(lowerBoundMs, window.EndMs, after, properties), cancellationToken);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
            {
                throw new HubSpotExportException(HubSpotErrorKind.InvalidResponse, "HubSpot response is missing the results array.");
            }

            foreach (var item in results.EnumerateArray())
            {
                var deal = ParseDeal(item, orderIdProperty);
                if (!seen.Add(deal.Id)) { duplicates++; continue; }
                // Server-side filtering is authoritative; this guards against anything outside the window.
                if (!window.Contains(deal.CreatedAtUtc)) { outside++; continue; }
                deals.Add(deal);
                lastCreatedMs = Math.Max(lastCreatedMs, deal.CreatedAtUtc.ToUnixTimeMilliseconds());
            }

            var next = NextCursor(root);
            if (next is null) break;
            if (next.Length == 0 || next == after) throw new HubSpotExportException(HubSpotErrorKind.Pagination, "HubSpot returned an invalid pagination cursor.");

            if (int.TryParse(next, NumberStyles.None, CultureInfo.InvariantCulture, out var offset) && offset >= SearchResultCap)
            {
                // Results are sorted by createdate ascending, so restart the query from the last
                // timestamp seen; overlapping Deals at that timestamp are removed by ID.
                if (lastCreatedMs <= lowerBoundMs)
                {
                    throw new HubSpotExportException(HubSpotErrorKind.Pagination, "More than 10,000 Deals share one creation timestamp; cannot page further.");
                }
                lowerBoundMs = lastCreatedMs;
                after = null;
            }
            else
            {
                after = next;
            }
        }

        deals.Sort((a, b) => a.CreatedAtUtc != b.CreatedAtUtc ? a.CreatedAtUtc.CompareTo(b.CreatedAtUtc) : CompareIds(a.Id, b.Id));
        return new DealSearchResult(deals, pages, duplicates, outside);
    }

    public static string BuildSearchBody(long fromMs, long toMs, string? after, string[] properties)
    {
        var body = new JsonObject
        {
            ["filterGroups"] = new JsonArray(new JsonObject
            {
                // Both filters in one group are ANDed: from (inclusive) <= createdate < to (exclusive).
                ["filters"] = new JsonArray(
                    new JsonObject { ["propertyName"] = "createdate", ["operator"] = "GTE", ["value"] = fromMs.ToString(CultureInfo.InvariantCulture) },
                    new JsonObject { ["propertyName"] = "createdate", ["operator"] = "LT", ["value"] = toMs.ToString(CultureInfo.InvariantCulture) }),
            }),
            ["sorts"] = new JsonArray(new JsonObject { ["propertyName"] = "createdate", ["direction"] = "ASCENDING" }),
            ["properties"] = new JsonArray(properties.Select(p => (JsonNode)JsonValue.Create(p)).ToArray()),
            ["limit"] = PageSize,
        };
        if (after is not null) body["after"] = after;
        return body.ToJsonString();
    }

    private static string? NextCursor(JsonElement root)
    {
        if (!root.TryGetProperty("paging", out var paging) || paging.ValueKind == JsonValueKind.Null) return null;
        if (paging.ValueKind != JsonValueKind.Object) throw new HubSpotExportException(HubSpotErrorKind.Pagination, "HubSpot returned malformed paging information.");
        if (!paging.TryGetProperty("next", out var next) || next.ValueKind == JsonValueKind.Null) return null;
        if (next.ValueKind != JsonValueKind.Object || !next.TryGetProperty("after", out var cursor)) throw new HubSpotExportException(HubSpotErrorKind.Pagination, "HubSpot returned malformed paging information.");
        return cursor.ValueKind switch
        {
            JsonValueKind.String => cursor.GetString()!,
            JsonValueKind.Number => cursor.GetRawText(),
            _ => throw new HubSpotExportException(HubSpotErrorKind.Pagination, "HubSpot returned an invalid pagination cursor."),
        };
    }

    private static Deal ParseDeal(JsonElement item, string orderIdProperty)
    {
        if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("id", out var idElement) || idElement.ValueKind != JsonValueKind.String
            || idElement.GetString() is not { Length: > 0 } id || !id.All(char.IsAsciiDigit))
        {
            throw new HubSpotExportException(HubSpotErrorKind.InvalidResponse, "HubSpot returned a Deal without a valid id.");
        }
        var properties = item.TryGetProperty("properties", out var p) && p.ValueKind == JsonValueKind.Object ? p : default;
        string? Get(string name) => properties.ValueKind == JsonValueKind.Object && properties.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        var created = Get("createdate");
        if (created is null || !DateTimeOffset.TryParse(created, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var createdAt))
        {
            throw new HubSpotExportException(HubSpotErrorKind.InvalidResponse, "HubSpot returned Deal " + id + " without a valid createdate.");
        }
        return new Deal(id, createdAt.ToUniversalTime(), Get("dealname"), Get("amount"), Get("deal_currency_code"),
            Get("pipeline"), Get("dealstage"), Get("closedate"), Get(orderIdProperty));
    }

    private static int CompareIds(string a, string b) => a.Length != b.Length ? a.Length.CompareTo(b.Length) : string.CompareOrdinal(a, b);

    private async Task<JsonDocument> SendWithRetryAsync(string body, CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            string failure;
            TimeSpan? retryAfter = null;
            int? status = null;
            using var attemptTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            attemptTimeout.CancelAfter(timeout);
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, SearchPath) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseContentRead, attemptTimeout.Token);
                status = (int)response.StatusCode;
                if (response.IsSuccessStatusCode)
                {
                    var text = await response.Content.ReadAsStringAsync(attemptTimeout.Token);
                    try { return JsonDocument.Parse(text); }
                    catch (JsonException) { throw new HubSpotExportException(HubSpotErrorKind.InvalidResponse, "HubSpot returned invalid JSON (HTTP " + status + ")."); }
                }
                // Response bodies are never surfaced: they can echo request data.
                switch (response.StatusCode)
                {
                    case HttpStatusCode.Unauthorized:
                        throw new HubSpotExportException(HubSpotErrorKind.Authentication, "HubSpot rejected the access token (HTTP 401). Check that HUBSPOT_ACCESS_TOKEN is valid and not expired.", status);
                    case HttpStatusCode.Forbidden:
                        throw new HubSpotExportException(HubSpotErrorKind.Permission, "HubSpot denied access (HTTP 403). The private app needs the crm.objects.deals.read scope.", status);
                }
                if (status is not (429 or 500 or 502 or 503 or 504))
                {
                    throw new HubSpotExportException(HubSpotErrorKind.RequestFailed, "HubSpot request failed (HTTP " + status + ").", status);
                }
                failure = status == 429 ? "rate limited (HTTP 429)" : "temporary server error (HTTP " + status + ")";
                retryAfter = RetryAfter(response.Headers.RetryAfter);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                failure = "request timed out after " + timeout.TotalSeconds.ToString(CultureInfo.InvariantCulture) + " s";
            }
            catch (HttpRequestException)
            {
                failure = "network error";
            }

            // Retry-After wins when present; a wait longer than MaxDelay is not attempted.
            var wait = retryAfter ?? retryPolicy.BackoffDelay(attempt, jitter());
            if (attempt >= retryPolicy.MaxAttempts || wait > retryPolicy.MaxDelay)
            {
                var suffix = attempt > 1 ? "; gave up after " + attempt + " attempts" : "";
                if (retryAfter is { } ra && wait > retryPolicy.MaxDelay) suffix += "; Retry-After " + Math.Ceiling(ra.TotalSeconds).ToString(CultureInfo.InvariantCulture) + " s exceeds the maximum wait";
                throw new HubSpotExportException(HubSpotErrorKind.Transient, "HubSpot " + failure + suffix + ". Try again later.", status);
            }
            await sleep(wait, cancellationToken);
        }
    }

    private TimeSpan? RetryAfter(RetryConditionHeaderValue? header)
    {
        if (header?.Delta is { } delta) return delta < TimeSpan.Zero ? TimeSpan.Zero : delta;
        if (header?.Date is { } date)
        {
            var wait = date - time.GetUtcNow();
            return wait < TimeSpan.Zero ? TimeSpan.Zero : wait;
        }
        return null;
    }
}
