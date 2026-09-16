param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($Path)
function Read-WorkbookXml($name) {
    $reader = [IO.StreamReader]::new($zip.GetEntry($name).Open())
    try { [xml]$reader.ReadToEnd() } finally { $reader.Dispose() }
}
try {
    $strings = @((Read-WorkbookXml 'xl/sharedStrings.xml').sst.si | ForEach-Object { $_.InnerText })
    $sheet = Read-WorkbookXml 'xl/worksheets/sheet1.xml'
    $rows = @(foreach ($row in $sheet.worksheet.sheetData.row) {
        $record = [ordered]@{ row = [int]$row.r }
        foreach ($cell in $row.c) {
            if ($null -eq $cell.v) { continue }
            $value = [string]$cell.v
            if ($cell.t -eq 's') { $value = $strings[[int]$value] }
            $record[($cell.r -replace '\d','')] = $value.Trim()
        }
        $record
    })
    ConvertTo-Json -InputObject $rows -Depth 5 -Compress
} finally { $zip.Dispose() }
