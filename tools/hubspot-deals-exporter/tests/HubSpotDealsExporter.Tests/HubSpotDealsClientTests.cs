using System.Net.Http.Headers;
using HubSpotDealsExporter;

namespace HubSpotDealsExporter.Tests;

public class HubSpotDealsClientTests
{
    private static readonly DateTimeOffset Yesterday = Hub.Now.AddDays(-1);

    [Fact]
    public async Task Retrieves_deals_with_read_only_search_request()
    {
        var h = new Hub.Harness(Hub.Page(null, Hub.Deal("101", Yesterday), Hub.Deal("102", Yesterday.AddHours(1))));
        var result = await h.RunAsync();

        Assert.Equal(["101", "102"], result.Deals.Select(d => d.Id));
        Assert.Equal(1, result.Pages);
        var request = Assert.Single(h.Handler.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("/crm/v3/objects/deals/search", request.Path);
        Assert.Equal("Bearer " + Hub.Token, request.Authorization);
        Assert.Equal(100, (int)request.Body!["limit"]!);
        Assert.Equal("createdate", (string)request.Body["sorts"]![0]!["propertyName"]!);
        var props = request.Body["properties"]!.AsArray().Select(p => (string)p!).ToArray();
        Assert.Equal(["dealname", "amount", "deal_currency_code", "pipeline", "dealstage", "createdate", "closedate", "optima_order_id"], props);
        var deal = result.Deals[0];
        Assert.Equal(("Order 101", "900", "PHP", "default", "appointmentscheduled", "ORD-101"), (deal.Name, deal.Amount, deal.Currency, deal.PipelineId, deal.StageId, deal.OrderId));
    }

    [Fact]
    public async Task Empty_results_produce_no_deals()
    {
        var h = new Hub.Harness(Hub.Json("{\"total\":0,\"results\":[]}"));
        var result = await h.RunAsync();
        Assert.Empty(result.Deals);
        Assert.Equal(1, result.Pages);
    }

    [Fact]
    public async Task Filters_server_side_on_exact_seven_day_utc_window()
    {
        var h = new Hub.Harness(Hub.Page(null));
        await h.RunAsync();
        var request = h.Handler.Requests[0];
        Assert.Equal(Hub.Now.AddDays(-7).ToUnixTimeMilliseconds().ToString(), Hub.Filter(request, "GTE"));
        Assert.Equal(Hub.Now.ToUnixTimeMilliseconds().ToString(), Hub.Filter(request, "LT"));
        Assert.Equal(7 * 24 * 3600 * 1000L, long.Parse(Hub.Filter(request, "LT")) - long.Parse(Hub.Filter(request, "GTE")));
        Assert.All(request.Body!["filterGroups"]![0]!["filters"]!.AsArray(), f => Assert.Equal("createdate", (string)f!["propertyName"]!));
    }

    [Fact]
    public async Task Paginates_until_no_next_cursor_with_a_fixed_window()
    {
        var h = new Hub.Harness(
            Hub.Page("100", Hub.Deal("1", Yesterday)),
            Hub.Page("200", Hub.Deal("2", Yesterday.AddMinutes(1))),
            Hub.Page(null, Hub.Deal("3", Yesterday.AddMinutes(2))));
        // Time moves during the export; the window must not.
        h.Handler.Requests.Clear();
        var task = h.RunAsync();
        h.Time.Now = Hub.Now.AddMinutes(5);
        var result = await task;

        Assert.Equal(["1", "2", "3"], result.Deals.Select(d => d.Id));
        Assert.Equal(3, result.Pages);
        Assert.Null(h.Handler.Requests[0].Body!["after"]);
        Assert.Equal("100", (string)h.Handler.Requests[1].Body!["after"]!);
        Assert.Equal("200", (string)h.Handler.Requests[2].Body!["after"]!);
        Assert.Single(h.Handler.Requests.Select(r => Hub.Filter(r, "LT")).Distinct());
        Assert.Single(h.Handler.Requests.Select(r => Hub.Filter(r, "GTE")).Distinct());
    }

    [Fact]
    public async Task Duplicate_ids_across_pages_are_exported_once()
    {
        var h = new Hub.Harness(
            Hub.Page("100", Hub.Deal("1", Yesterday), Hub.Deal("2", Yesterday)),
            Hub.Page(null, Hub.Deal("2", Yesterday), Hub.Deal("3", Yesterday)));
        var result = await h.RunAsync();
        Assert.Equal(["1", "2", "3"], result.Deals.Select(d => d.Id));
        Assert.Equal(1, result.DuplicatesSkipped);
    }

    [Fact]
    public async Task Date_boundaries_are_start_inclusive_end_exclusive()
    {
        var start = Hub.Now.AddDays(-7);
        var h = new Hub.Harness(Hub.Page(null,
            Hub.Deal("10", start.AddMilliseconds(-1)),   // just before: excluded
            Hub.Deal("11", start),                        // exactly start: included
            Hub.Deal("12", Hub.Now.AddMilliseconds(-1)), // last millisecond: included
            Hub.Deal("13", Hub.Now)));                    // exactly end: excluded
        var result = await h.RunAsync();
        Assert.Equal(["11", "12"], result.Deals.Select(d => d.Id));
        Assert.Equal(2, result.OutsideWindowSkipped);
    }

    [Fact]
    public void Window_is_utc_and_independent_of_the_local_offset()
    {
        // 8 PM in Manila is 12:00 UTC; the window is computed from the UTC instant.
        var manila = new FakeTime(new DateTimeOffset(2026, 10, 18, 20, 0, 0, TimeSpan.FromHours(8)));
        var window = ExportWindow.LastDays(manila);
        Assert.Equal(new DateTimeOffset(2026, 10, 11, 12, 0, 0, TimeSpan.Zero), window.StartUtc);
        Assert.Equal(new DateTimeOffset(2026, 10, 18, 12, 0, 0, TimeSpan.Zero), window.EndUtc);
        Assert.Equal(TimeSpan.Zero, window.StartUtc.Offset);
    }

    [Fact]
    public void Window_end_is_truncated_to_whole_milliseconds()
    {
        var window = ExportWindow.LastDays(new FakeTime(Hub.Now.AddTicks(9999)));
        Assert.Equal(Hub.Now.AddMilliseconds(0.9999).ToUnixTimeMilliseconds(), window.EndMs);
        Assert.Equal(window.EndUtc, DateTimeOffset.FromUnixTimeMilliseconds(window.EndMs));
    }

    [Fact]
    public async Task Missing_optional_properties_are_null_not_errors()
    {
        var sparse = Hub.Deal("7", Yesterday, p =>
        {
            foreach (var name in new[] { "dealname", "amount", "deal_currency_code", "pipeline", "dealstage", "closedate", "optima_order_id" }) p.Remove(name);
        });
        sparse["properties"]!["amount"] = null;
        var h = new Hub.Harness(Hub.Page(null, sparse));
        var deal = Assert.Single((await h.RunAsync()).Deals);
        Assert.Equal("7", deal.Id);
        Assert.Null(deal.Name); Assert.Null(deal.Amount); Assert.Null(deal.Currency); Assert.Null(deal.CloseDate); Assert.Null(deal.OrderId);
    }

    [Fact]
    public async Task Monetary_values_and_currencies_are_preserved_verbatim()
    {
        var h = new Hub.Harness(Hub.Page(null,
            Hub.Deal("1", Yesterday, p => { p["amount"] = "1250.50"; p["deal_currency_code"] = "USD"; }),
            Hub.Deal("2", Yesterday, p => { p["amount"] = "900.00"; })));
        var deals = (await h.RunAsync()).Deals;
        Assert.Equal(("1250.50", "USD"), (deals[0].Amount, deals[0].Currency));
        Assert.Equal(("900.00", "PHP"), (deals[1].Amount, deals[1].Currency));
    }

    [Theory]
    [InlineData(429)]
    [InlineData(500)]
    [InlineData(502)]
    [InlineData(503)]
    [InlineData(504)]
    public async Task Transient_status_is_retried_with_exponential_backoff(int status)
    {
        var h = new Hub.Harness(Hub.Status(status), Hub.Status(status), Hub.Page(null, Hub.Deal("1", Yesterday)));
        var result = await h.RunAsync();
        Assert.Single(result.Deals);
        Assert.Equal(3, h.Handler.Requests.Count);
        Assert.Equal([TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2)], h.RetryDelays);
    }

    [Fact]
    public async Task Retry_after_seconds_is_honored()
    {
        var h = new Hub.Harness(Hub.Status(429, r => r.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(7))), Hub.Page(null));
        await h.RunAsync();
        Assert.Equal([TimeSpan.FromSeconds(7)], h.RetryDelays);
    }

    [Fact]
    public async Task Retry_after_http_date_is_honored()
    {
        var h = new Hub.Harness(Hub.Status(503, r => r.Headers.RetryAfter = new RetryConditionHeaderValue(Hub.Now.AddSeconds(12))), Hub.Page(null));
        await h.RunAsync();
        Assert.Equal([TimeSpan.FromSeconds(12)], h.RetryDelays);
    }

    [Fact]
    public async Task Retry_after_longer_than_maximum_fails_without_waiting()
    {
        var h = new Hub.Harness(Hub.Status(429, r => r.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(120))));
        var error = await Assert.ThrowsAsync<HubSpotExportException>(h.RunAsync);
        Assert.Equal(HubSpotErrorKind.Transient, error.Kind);
        Assert.Contains("Retry-After 120 s", error.Message);
        Assert.Single(h.Handler.Requests);
        Assert.Empty(h.RetryDelays);
    }

    [Fact]
    public async Task Retries_are_exhausted_after_five_attempts()
    {
        var h = new Hub.Harness(Hub.Status(503));
        var error = await Assert.ThrowsAsync<HubSpotExportException>(h.RunAsync);
        Assert.Equal(HubSpotErrorKind.Transient, error.Kind);
        Assert.Contains("gave up after 5 attempts", error.Message);
        Assert.Equal(5, h.Handler.Requests.Count);
        Assert.Equal([1, 2, 4, 8], h.RetryDelays.Select(d => d.TotalSeconds));
    }

    [Theory]
    [InlineData(401, HubSpotErrorKind.Authentication)]
    [InlineData(403, HubSpotErrorKind.Permission)]
    [InlineData(400, HubSpotErrorKind.RequestFailed)]
    [InlineData(404, HubSpotErrorKind.RequestFailed)]
    public async Task Permanent_errors_are_not_retried(int status, HubSpotErrorKind kind)
    {
        var h = new Hub.Harness(Hub.Status(status), Hub.Page(null));
        var error = await Assert.ThrowsAsync<HubSpotExportException>(h.RunAsync);
        Assert.Equal(kind, error.Kind);
        Assert.Equal(status, error.Status);
        Assert.Single(h.Handler.Requests);
        Assert.DoesNotContain(Hub.Token, error.Message);
        Assert.DoesNotContain("echo", error.Message); // response body is never surfaced
    }

    [Fact]
    public async Task Network_timeout_is_retried_then_succeeds()
    {
        var h = new Hub.Harness(TimeSpan.FromMilliseconds(50), Hub.Hang(), Hub.Throw(new HttpRequestException("connection reset")), Hub.Page(null, Hub.Deal("1", Yesterday)));
        var result = await h.RunAsync();
        Assert.Single(result.Deals);
        Assert.Equal(3, h.Handler.Requests.Count);
    }

    [Fact]
    public async Task Persistent_timeout_is_reported_after_retries()
    {
        var h = new Hub.Harness(TimeSpan.FromMilliseconds(20), Hub.Hang());
        var error = await Assert.ThrowsAsync<HubSpotExportException>(h.RunAsync);
        Assert.Contains("timed out", error.Message);
        Assert.Equal(5, h.Handler.Requests.Count);
    }

    [Fact]
    public async Task Caller_cancellation_is_not_treated_as_a_timeout()
    {
        var h = new Hub.Harness(Hub.Hang());
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => h.Client.SearchDealsCreatedAsync(h.Window, "optima_order_id", cts.Token));
        Assert.Single(h.Handler.Requests);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("{\"total\":1}")]
    [InlineData("{\"results\":{}}")]
    [InlineData("[]")]
    public async Task Invalid_or_incomplete_json_is_rejected(string body)
    {
        var h = new Hub.Harness(Hub.Json(body));
        var error = await Assert.ThrowsAsync<HubSpotExportException>(h.RunAsync);
        Assert.Equal(HubSpotErrorKind.InvalidResponse, error.Kind);
        Assert.Single(h.Handler.Requests);
    }

    [Theory]
    [InlineData("{\"results\":[{\"properties\":{\"createdate\":\"2026-10-17T00:00:00Z\"}}]}")]
    [InlineData("{\"results\":[{\"id\":\"abc\",\"properties\":{\"createdate\":\"2026-10-17T00:00:00Z\"}}]}")]
    [InlineData("{\"results\":[{\"id\":\"5\",\"properties\":{\"dealname\":\"x\"}}]}")]
    [InlineData("{\"results\":[{\"id\":\"5\",\"properties\":{\"createdate\":\"yesterday\"}}]}")]
    public async Task Deals_missing_required_fields_are_rejected(string body)
    {
        var h = new Hub.Harness(Hub.Json(body));
        var error = await Assert.ThrowsAsync<HubSpotExportException>(h.RunAsync);
        Assert.Equal(HubSpotErrorKind.InvalidResponse, error.Kind);
    }

    [Theory]
    [InlineData("{\"results\":[],\"paging\":{\"next\":{\"after\":\"\"}}}")]
    [InlineData("{\"results\":[],\"paging\":{\"next\":{}}}")]
    [InlineData("{\"results\":[],\"paging\":\"oops\"}")]
    public async Task Malformed_pagination_is_rejected(string body)
    {
        var h = new Hub.Harness(Hub.Json(body));
        var error = await Assert.ThrowsAsync<HubSpotExportException>(h.RunAsync);
        Assert.Equal(HubSpotErrorKind.Pagination, error.Kind);
    }

    [Fact]
    public async Task Repeated_cursor_is_rejected_instead_of_looping()
    {
        var h = new Hub.Harness(Hub.Page("100", Hub.Deal("1", Yesterday)), Hub.Page("100", Hub.Deal("2", Yesterday)));
        var error = await Assert.ThrowsAsync<HubSpotExportException>(h.RunAsync);
        Assert.Equal(HubSpotErrorKind.Pagination, error.Kind);
        Assert.Equal(2, h.Handler.Requests.Count);
    }

    [Fact]
    public async Task Search_cap_restarts_from_last_seen_timestamp_and_dedupes()
    {
        var t1 = Yesterday; var t2 = Yesterday.AddMinutes(1);
        var h = new Hub.Harness(
            Hub.Page("10000", Hub.Deal("1", t1), Hub.Deal("2", t2)),
            Hub.Page(null, Hub.Deal("2", t2), Hub.Deal("3", t2.AddMinutes(1))));
        var result = await h.RunAsync();
        Assert.Equal(["1", "2", "3"], result.Deals.Select(d => d.Id));
        var second = h.Handler.Requests[1];
        Assert.Null(second.Body!["after"]);
        Assert.Equal(t2.ToUnixTimeMilliseconds().ToString(), Hub.Filter(second, "GTE"));
        Assert.Equal(Hub.Filter(h.Handler.Requests[0], "LT"), Hub.Filter(second, "LT"));
    }

    [Fact]
    public async Task Pages_are_spaced_to_respect_search_rate_limits()
    {
        var h = new Hub.Harness(Hub.Page("100", Hub.Deal("1", Yesterday)), Hub.Page(null));
        await h.RunAsync();
        Assert.Equal([TimeSpan.FromMilliseconds(250)], h.Delays);
    }
}
