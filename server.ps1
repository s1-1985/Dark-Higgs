$root = "C:\Users\user\Desktop\Dark higgs\prototype"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://localhost:3000/')
$listener.Start()
Write-Host "Serving on http://localhost:3000/"
$mimes = @{'.html'='text/html';'.js'='application/javascript';'.css'='text/css';'.png'='image/png';'.ico'='image/x-icon'}
while ($true) {
    $ctx = $listener.GetContext()
    $local = $ctx.Request.Url.LocalPath.TrimStart('/')
    if ($local -eq '') { $local = 'index.html' }
    $path = Join-Path $root $local
    if (Test-Path $path -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($path)
        $ctx.Response.ContentType = if ($mimes[$ext]) { $mimes[$ext] } else { 'application/octet-stream' }
        $bytes = [System.IO.File]::ReadAllBytes($path)
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
}
