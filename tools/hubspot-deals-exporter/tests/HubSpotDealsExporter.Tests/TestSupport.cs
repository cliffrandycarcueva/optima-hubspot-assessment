using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using HubSpotDealsExporter;

namespace HubSpotDealsExporter.Tests;

public sealed class FakeTime(DateTimeOffset now) : TimeProvider
{
    public DateTimeOffset Now { get; set; } = now;
    public override DateTimeOffset GetUtcNow() => Now;
}

public sealed record RecordedRequest(HttpMethod Method, string Path, string? Authorization, JsonNode? Body);

/// <summary>Scripted HubSpot: each call gets the next response factory (the last one repeats).</summary>
public sealed class StubHandler(params Func<RecordedRequest, CancellationToken, Task<HttpResponseMessage>>[] script) : HttpMessageHandler
{
    private readonly Queue<Func<RecordedRequest, CancellationToken, Task<HttpResponseMessage>>> queue = new(script);
    private Func<RecordedRequest, CancellationToken, Task<HttpResponseMessage>>? last;
    public List<RecordedRequest> Requests { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? null : JsonNode.Parse(await request.Content.ReadAsStringAsync(cancellationToken));
        var recorded = new RecordedRequest(request.Method, request.RequestUri!.AbsolutePath, request.Headers.Authorization?.ToString(), body);
        Requests.Add(recorded);
        if (queue.Count > 0) last = queue.Dequeue();
        return await last!(recorded, cancellationToken);
    }
}

public static class Hub
{
    public const string Token = "pat-na1-TEST-SECRET-TOKEN-0123456789";
    public static readonly DateTimeOffset Now = new(2026, 10, 18, 12, 0, 0, TimeSpan.Zero);

    public static JsonObject Deal(string id, DateTimeOffset created, Action<JsonObject>? configure = null)
    {
        var properties = new JsonObject
        {
            ["dealname"] = "Order " + id,
            ["amount"] = "900",
            ["deal_currency_code"] = "PHP",
            ["pipeline"] = "default",
            ["dealstage"] = "appointmentscheduled",
            ["createdate"] = created.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),
            ["closedate"] = "2026-09-20T06:32:00Z",
            ["optima_order_id"] = "ORD-" + id,
        };
        configure?.Invoke(properties);
        return new JsonObject { ["id"] = id, ["properties"] = properties, ["archived"] = false };
    }

    public static Func<RecordedRequest, CancellationToken, Task<HttpResponseMessage>> Page(string? after, params JsonObject[] deals)
    {
        var page = new JsonObject { ["total"] = deals.Length, ["results"] = new JsonArray(deals.Select(d => (JsonNode)d.DeepClone()).ToArray()) };
        if (after is not null) page["paging"] = new JsonObject { ["next"] = new JsonObject { ["after"] = after, ["link"] = "?after=" + after } };
        return Json(page.ToJsonString());
    }

    public static Func<RecordedRequest, CancellationToken, Task<HttpResponseMessage>> Json(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        (_, _) => Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") });

    public static Func<RecordedRequest, CancellationToken, Task<HttpResponseMessage>> Status(int status, Action<HttpResponseMessage>? configure = null) =>
        (_, _) =>
        {
            var response = new HttpResponseMessage((HttpStatusCode)status)
            {
                Content = new StringContent("{\"message\":\"echo " + Token + "\",\"category\":\"ERROR\"}", Encoding.UTF8, "application/json"),
            };
            configure?.Invoke(response);
            return Task.FromResult(response);
        };

    public static Func<RecordedRequest, CancellationToken, Task<HttpResponseMessage>> Throw(Exception error) => (_, _) => Task.FromException<HttpResponseMessage>(error);

    public static Func<RecordedRequest, CancellationToken, Task<HttpResponseMessage>> Hang() =>
        async (_, ct) => { await Task.Delay(Timeout.Infinite, ct); throw new InvalidOperationException(); };

    public sealed class Harness
    {
        public FakeTime Time { get; } = new(Now);
        public List<TimeSpan> Delays { get; } = [];
        public StubHandler Handler { get; }
        public HubSpotDealsClient Client { get; }

        public Harness(params Func<RecordedRequest, CancellationToken, Task<HttpResponseMessage>>[] script) : this(TimeSpan.FromSeconds(30), script) { }

        public Harness(TimeSpan requestTimeout, params Func<RecordedRequest, CancellationToken, Task<HttpResponseMessage>>[] script)
        {
            Handler = new StubHandler(script);
            var http = new HttpClient(Handler) { BaseAddress = new Uri("https://api.hubapi.com") };
            Client = new HubSpotDealsClient(http, Token, Time,
                delay: (d, _) => { Delays.Add(d); return Task.CompletedTask; },
                random: () => 1.0, requestTimeout: requestTimeout);
        }

        public ExportWindow Window => ExportWindow.LastDays(Time);
        public Task<DealSearchResult> RunAsync() => Client.SearchDealsCreatedAsync(Window, "optima_order_id");
        /// <summary>Retry waits only; the fixed 250 ms gap between pages is excluded.</summary>
        public List<TimeSpan> RetryDelays => Delays.Where(d => d != TimeSpan.FromMilliseconds(250)).ToList();
    }

    public static string Filter(RecordedRequest request, string op) =>
        request.Body!["filterGroups"]![0]!["filters"]!.AsArray().Single(f => (string)f!["operator"]! == op)!["value"]!.GetValue<string>();

    public static string ToJson(object value) => JsonSerializer.Serialize(value);
}
