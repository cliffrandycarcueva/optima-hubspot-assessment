using HubSpotDealsExporter;

namespace HubSpotDealsExporter.Tests;

public class RetryPolicyTests
{
    private readonly RetryPolicy policy = RetryPolicy.Default;

    [Fact]
    public void Defaults_match_the_nestjs_integration()
    {
        Assert.Equal(new RetryPolicy(5, TimeSpan.FromSeconds(1), 2, TimeSpan.FromSeconds(30)), policy);
    }

    [Fact]
    public void Exponential_caps_are_bounded_by_maximum_delay()
    {
        Assert.Equal([1, 2, 4, 8, 16, 30, 30], Enumerable.Range(1, 7).Select(n => policy.BackoffDelay(n, 1).TotalSeconds));
    }

    [Fact]
    public void Equal_jitter_stays_between_half_and_full_cap()
    {
        Assert.Equal(TimeSpan.FromSeconds(2), policy.BackoffDelay(3, 0));
        Assert.Equal(TimeSpan.FromSeconds(3), policy.BackoffDelay(3, 0.5));
        Assert.Equal(TimeSpan.FromSeconds(4), policy.BackoffDelay(3, 1));
        var random = new Random(1234);
        for (var i = 0; i < 1000; i++)
        {
            var retry = 1 + i % 8;
            var cap = Math.Min(30000, 1000 * Math.Pow(2, retry - 1));
            var ms = policy.BackoffDelay(retry, random.NextDouble()).TotalMilliseconds;
            Assert.InRange(ms, cap / 2, cap);
        }
        Assert.Equal(TimeSpan.FromSeconds(1), policy.BackoffDelay(1, 5));
        Assert.Equal(TimeSpan.FromMilliseconds(500), policy.BackoffDelay(1, -5));
    }
}
