# DSH draft prefill through Windows UI Automation; never submits a message.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Result($code, $prefilled = $false, $verified = $false) {
    ConvertTo-Json -InputObject @{ code=$code; prefilled=$prefilled; workspaceVerified=$verified } -Compress
    exit 0
}
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if (-not $request.hwnd -or -not $request.workspace -or -not $request.prompt) { Result 'invalid-request' }
    if (-not (Test-Path -LiteralPath $request.workspace -PathType Container)) { Result 'workspace-missing' }
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DshDraftKeys {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    public static void Paste() {
        keybd_event(0x11,0,0,UIntPtr.Zero); keybd_event(0x56,0,0,UIntPtr.Zero);
        keybd_event(0x56,0,2,UIntPtr.Zero); keybd_event(0x11,0,2,UIntPtr.Zero);
    }
}
'@
    $root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$request.hwnd)
    $owner = Get-Process -Id $root.Current.ProcessId
    if ($owner.ProcessName -ne 'DSH Desktop') { Result 'wrong-window' }
    $workspaceName = Split-Path -Leaf $request.workspace.TrimEnd('\','/')
    $editCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit)
    $treeCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::TreeItem)
    $code = 'input-unavailable'
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        $trees = $root.FindAll([Windows.Automation.TreeScope]::Descendants,$treeCondition)
        $header = ''; $selectedWorkspace = ''; $workspaceMatchCount = 0
        foreach ($row in $trees) {
            if ($row.Current.ClassName -match '_projectRow') {
                $header = $row.Current.Name
                if ($header -eq $workspaceName) { $workspaceMatchCount++ }
            }
            $selection = $null
            if ($row.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$selection) -and $selection.Current.IsSelected) { $selectedWorkspace = $header }
        }
        if ($selectedWorkspace -ne $workspaceName -or $workspaceMatchCount -ne 1) {
            $code = 'workspace-unconfirmed'
            Start-Sleep -Milliseconds 250
            continue
        }
        $edits = $root.FindAll([Windows.Automation.TreeScope]::Descendants,$editCondition)
        $candidates = @($edits | Where-Object { $_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and $_.Current.ClassName -match '_input(?:\s|$)' -and $_.Current.Name.Contains('@') -and $_.Current.Name.Contains('/') })
        if ($candidates.Count -ne 1) { Start-Sleep -Milliseconds 250; continue }
        $value = $null
        if (-not $candidates[0].TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$value) -or $value.Current.IsReadOnly) { Result 'input-readonly' $false $true }
        $current = $value.Current.Value.TrimEnd([char[]]"`r`n")
        if ($current -eq $request.prompt) { Result 'already-filled' $true $true }
        if ($current.Trim().Length -gt 0) { Result 'draft-present' $false $true }
        # DSH's controlled editor rejects UIA SetValue. Focus the actual editor,
        # confirm the foreground HWND and empty draft, then paste without Enter.
        $candidates[0].SetFocus()
        Start-Sleep -Milliseconds 80
        if (-not $candidates[0].Current.HasKeyboardFocus -or [DshDraftKeys]::GetForegroundWindow().ToInt64() -ne [long]$request.hwnd) { Result 'focus-unconfirmed' $false $true }
        if ($value.Current.Value.Trim().Length -gt 0) { Result 'draft-present' $false $true }
        [Windows.Forms.Clipboard]::SetText([string]$request.prompt)
        if (-not $candidates[0].Current.HasKeyboardFocus -or [DshDraftKeys]::GetForegroundWindow().ToInt64() -ne [long]$request.hwnd) { Result 'focus-unconfirmed' $false $true }
        [DshDraftKeys]::Paste()
        for ($check=0;$check -lt 8;$check++) {
            Start-Sleep -Milliseconds 100
            if ($value.Current.Value.TrimEnd([char[]]"`r`n") -eq $request.prompt) { Result 'prefilled' $true $true }
        }
        Result 'verification-failed' $false $true
    }
    Result $code
} catch {
    if ($env:AIPET_DSH_DRAFT_DEBUG -eq '1') { [Console]::Error.WriteLine($_.Exception.GetType().FullName + ' at line ' + $_.InvocationInfo.ScriptLineNumber) }
    # Do not echo the prompt, any existing draft, or private UI contents.
    Result 'automation-unavailable'
}
