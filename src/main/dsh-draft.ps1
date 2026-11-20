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
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    public static void Paste() {
        keybd_event(0x11,0,0,UIntPtr.Zero); keybd_event(0x56,0,0,UIntPtr.Zero);
        keybd_event(0x56,0,2,UIntPtr.Zero); keybd_event(0x11,0,2,UIntPtr.Zero);
    }
}
'@
    $root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$request.hwnd)
    $owner = Get-Process -Id $root.Current.ProcessId
    if ($owner.ProcessName -notin @('DSH Desktop', 'DSH NEXT')) { Result 'wrong-window' }
    if (($owner.ProcessName -eq 'DSH NEXT') -ne ($request.next -eq $true)) { Result 'wrong-window' }
    $workspaceName = Split-Path -Leaf $request.workspace.TrimEnd('\','/')
    $editCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit)
    $treeCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::TreeItem)
    $previousSelection = ''; $targetProjectRuntime = ''
    if ($request.next) {
        if (-not $request.workspaceTitle) { Result 'workspace-unregistered' }
        $workspaceName = [string]$request.workspaceTitle
        $trees = $root.FindAll([Windows.Automation.TreeScope]::Descendants,$treeCondition)
        $projects = @($trees | Where-Object { $_.Current.ClassName -match '_projectRow' -and $_.Current.Name -eq $workspaceName })
        if ($projects.Count -ne 1) { Result 'workspace-unconfirmed' }
        $targetProjectRuntime = $projects[0].GetRuntimeId() -join ','
        foreach ($row in $trees) {
            $selection = $null
            if ($row.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$selection) -and $selection.Current.IsSelected) {
                $previousSelection = $row.GetRuntimeId() -join ','
            }
        }
        if ([DshDraftKeys]::GetForegroundWindow().ToInt64() -ne [long]$request.hwnd) { Result 'focus-unconfirmed' }
        $bounds = $projects[0].Current.BoundingRectangle
        if ($projects[0].Current.IsOffscreen -or $bounds.IsEmpty) { Result 'workspace-offscreen' }
        # The shipped NEXT sidebar exposes project actions only while hovered.
        [void][DshDraftKeys]::SetCursorPos([int]($bounds.Left + $bounds.Width / 2), [int]($bounds.Top + $bounds.Height / 2))
        Start-Sleep -Milliseconds 180
        $buttonCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button)
        $buttons = $projects[0].FindAll([Windows.Automation.TreeScope]::Descendants,$buttonCondition)
        $names = @(('New session in ' + $workspaceName), ('在“{0}”中新建会话' -f $workspaceName))
        $newSession = @($buttons | Where-Object { $_.Current.Name -in $names -and $_.Current.IsEnabled -and -not $_.Current.IsOffscreen })
        $invoke = $null
        if ($newSession.Count -ne 1 -or -not $newSession[0].TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)) { Result 'workspace-action-unavailable' }
        if ([DshDraftKeys]::GetForegroundWindow().ToInt64() -ne [long]$request.hwnd) { Result 'focus-unconfirmed' }
        $invoke.Invoke()
    }
    $code = 'input-unavailable'
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        $trees = $root.FindAll([Windows.Automation.TreeScope]::Descendants,$treeCondition)
        $header = ''; $selectedWorkspace = ''; $workspaceMatchCount = 0; $selectedRuntime = ''
        foreach ($row in $trees) {
            if ($row.Current.ClassName -match '_projectRow') {
                # Hover actions contribute their labels to a project's accessible
                # name. Keep the verified project row identity across that change.
                $isTarget = if ($request.next) { ($row.GetRuntimeId() -join ',') -eq $targetProjectRuntime } else { $row.Current.Name -eq $workspaceName }
                $header = if ($isTarget) { $workspaceName } else { $row.Current.Name }
                if ($isTarget) { $workspaceMatchCount++ }
            }
            $selection = $null
            if ($row.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$selection) -and $selection.Current.IsSelected) { $selectedWorkspace = $header; $selectedRuntime = $row.GetRuntimeId() -join ',' }
        }
        if ($selectedWorkspace -ne $workspaceName -or $workspaceMatchCount -ne 1 -or ($request.next -and $selectedRuntime -eq $previousSelection)) {
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
