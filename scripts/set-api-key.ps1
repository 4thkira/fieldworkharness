$ErrorActionPreference = 'Stop'

Write-Host 'Fieldwork API key setup'
Write-Host 'The key will be hidden while you paste it and saved in your Windows user environment.'
Write-Host 'It will not be written to Fieldwork configuration or room-preferences files.'
Write-Host ''

$secureKey = Read-Host 'Paste the API key' -AsSecureString
if ($secureKey.Length -eq 0) {
  Write-Error 'No API key was entered; nothing changed.'
}

$pointer = [IntPtr]::Zero
$plainKey = $null
try {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  [Environment]::SetEnvironmentVariable('FIELDWORK_API_KEY', $plainKey, 'User')
} finally {
  $plainKey = $null
  if ($pointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
  $secureKey.Dispose()
}

Write-Host ''
Write-Host 'Saved FIELDWORK_API_KEY for your Windows user account.'
Write-Host 'Fully stop Fieldwork and start it again. The restart button alone cannot inherit a newly changed environment.'
