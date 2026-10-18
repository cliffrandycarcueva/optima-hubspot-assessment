using HubSpotDealsExporter;

using var cancellation = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancellation.Cancel(); };
try
{
    return await Cli.RunAsync(args, Console.Out, Console.Error, CliEnvironment.System(), cancellation.Token);
}
catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
{
    Console.Error.WriteLine("Export cancelled; no file was written.");
    return 130;
}
