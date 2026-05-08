# Run as Administrator on Windows
Write-Host 'Installing OpenSSH Server...' -ForegroundColor Cyan

$result = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
if ($result.State -ne 'Installed') {
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
    Write-Host 'OpenSSH Server installed.' -ForegroundColor Green
} else {
    Write-Host 'OpenSSH Server already installed.' -ForegroundColor Green
}

Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
Write-Host 'SSH service started.' -ForegroundColor Green

$rule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if (-not $rule) {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
    Write-Host 'Firewall rule added.' -ForegroundColor Green
}

$ip = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notlike '*Loopback*' } | Select-Object -First 1 -ExpandProperty IPAddress
Write-Host ''
Write-Host '====================================' -ForegroundColor Yellow
Write-Host "IP: $ip" -ForegroundColor White
Write-Host "User: $env:USERNAME" -ForegroundColor White
Write-Host 'SSH is ready!' -ForegroundColor Green
Write-Host '====================================' -ForegroundColor Yellow
