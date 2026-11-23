$ErrorActionPreference = "Stop"

$repo = "hrygo/gemini-github-mcp-proxy"
$baseUrl = "https://github.com/$repo/releases/latest/download"
$archive = "gemini-github-mcp-proxy.tgz"
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("gemini-github-mcp-" + [guid]::NewGuid())

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
    -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "未找到 npm。请先安装 Node.js 22 或更高版本。"
}
$nodeMajor = [int](((node --version).TrimStart("v") -split "\.")[0])
if ($nodeMajor -lt 22) {
    throw "当前 Node.js 版本过低。请升级到 Node.js 22 或更高版本。"
}

New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
    $archivePath = Join-Path $tempDir $archive
    $checksumsPath = Join-Path $tempDir "SHA256SUMS"

    Write-Host "正在下载 $archive..."
    Invoke-WebRequest -UseBasicParsing "$baseUrl/$archive" -OutFile $archivePath
    Invoke-WebRequest -UseBasicParsing "$baseUrl/SHA256SUMS" -OutFile $checksumsPath

    $expected = ((Get-Content $checksumsPath -First 1) -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
    if ($expected -ne $actual) {
        throw "SHA-256 校验失败。"
    }

    Write-Host "正在安装 Gemini GitHub MCP..."
    $npmMajor = [int](((npm --version) -split "\.")[0])
    if ($npmMajor -ge 12) {
        npm install --global --allow-scripts=esbuild,fsevents,workerd $archivePath
    }
    else {
        npm install --global $archivePath
    }
    gemini-github-mcp --version

    Write-Host ""
    Write-Host "安装完成。下一步："
    Write-Host "  1. npx wrangler login"
    Write-Host "  2. gemini-github-mcp setup"
    Write-Host ""
    Write-Host "每个使用者必须使用自己的 Cloudflare 账号和 GitHub PAT。"
}
finally {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
}
