param([Parameter(Mandatory = $true)][string]$Ledger)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$Ledger = (Get-Item -LiteralPath $Ledger).FullName
$unicode = [string][char]0x4e2d + [char]0x6587
$directory = Join-Path ([IO.Path]::GetTempPath()) ("ledger $unicode [qa] '`$&-" + [guid]::NewGuid())
[IO.Directory]::CreateDirectory($directory) | Out-Null
$descriptor = Join-Path $directory 'connection.json'
$job = Start-Job -ArgumentList $descriptor -ScriptBlock {
    param($Descriptor)
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        $token = 'synthetic-test-capability-1234567890'
        $value = @{ transport = 'tcp'; address = ('127.0.0.1:' + $listener.LocalEndpoint.Port); token = $token }
        [IO.File]::WriteAllText($Descriptor, ($value | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
        while ($true) {
            if (-not $listener.Pending()) { Start-Sleep -Milliseconds 30; continue }
            $client = $listener.AcceptTcpClient()
            try {
                $stream = $client.GetStream()
                $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
                $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
                $request = $reader.ReadLine() | ConvertFrom-Json
                if ($request.token -ne $token) { throw 'Wrong token' }
                $request.PSObject.Properties.Remove('token')
                $writer.WriteLine((@{ ok = $true; value = $request } | ConvertTo-Json -Depth 40 -Compress))
                $writer.Flush()
            } finally { $client.Dispose() }
        }
    } finally { $listener.Stop() }
}
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not [IO.File]::Exists($descriptor)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Test server startup timed out' }
        Start-Sleep -Milliseconds 50
    }
    $patch = @{ revision = 0; requestId = 'powershell-test'; nodes = @(@{ id = 'test'; purpose = $unicode; note = 'literal $() ` " \ text' }) }
    $json = $patch | ConvertTo-Json -Depth 30
    foreach ($encoding in @('UTF8', 'Unicode', 'BigEndianUnicode')) {
        $file = Join-Path $directory ("patch $unicode [1] '$&-$encoding.json")
        $json | Out-File -LiteralPath $file -Encoding $encoding
        $cliArgs = @('graph', 'apply', 'case-1', '--file', $file, '--preview', '--connection', $descriptor)
        $raw = & $Ledger @cliArgs
        if ($LASTEXITCODE -ne 0) { throw "CLI failed for $encoding" }
        $result = $raw | ConvertFrom-Json
        if ($result.patch.nodes[0].purpose -ne $unicode -or -not $result.preview) { throw "Unicode or arguments failed for $encoding" }
    }
    $previousEncoding = $OutputEncoding
    try {
        $OutputEncoding = [Text.UTF8Encoding]::new($false)
        $raw = $json | & $Ledger graph apply case-1 --file - --connection $descriptor
        if ($LASTEXITCODE -ne 0) { throw 'stdin failed' }
        if (($raw | ConvertFrom-Json).patch.nodes[0].purpose -ne $unicode) { throw 'stdin Unicode failed' }
    } finally { $OutputEncoding = $previousEncoding }
    $output = Join-Path $directory "result $unicode [1].json"
    & $Ledger graph cases --connection $descriptor --output $output
    if ($LASTEXITCODE -ne 0) { throw 'Output file failed' }
    if (([IO.File]::ReadAllText($output, [Text.Encoding]::UTF8) | ConvertFrom-Json).action -ne 'cases') { throw 'Wrong output file' }
    Write-Output ('PASS: PowerShell ' + $PSVersionTable.PSVersion + '; UTF8/UTF16LE/UTF16BE, literal paths, stdin, JSON and exit codes')
} finally {
    Stop-Job $job
    Remove-Job $job -Force
    if ([IO.Directory]::Exists($directory)) { [IO.Directory]::Delete($directory, $true) }
}
