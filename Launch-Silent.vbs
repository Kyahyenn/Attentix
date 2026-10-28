' Attentix - double-click to start with NO command-prompt window.
' First run installs what the app needs; the server then opens your browser by itself.
' Stop it from the dashboard ("Shut down server"). Messages go to server.log next to this file.
Option Explicit

Dim shell, fso, dir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir

' Node.js present? (Window style 0 = hidden, True = wait for it to finish.)
If shell.Run("cmd /c where node >nul 2>nul", 0, True) <> 0 Then
  MsgBox "Node.js 20 or newer is needed to run from source." & vbCrLf & "Install it from https://nodejs.org, or use Attentix-win.exe, which needs nothing installed.", vbExclamation, "Attentix"
  WScript.Quit 1
End If

' First run: install dependencies, hidden, and wait for it.
If Not fso.FolderExists(dir & "\node_modules") Then
  shell.Popup "First run: installing the components this app needs. This needs internet and takes about a minute." & vbCrLf & "Your browser will open when the app is ready.", 6, "Attentix", 64
  If shell.Run("cmd /c npm install --omit=dev --no-audit --no-fund > install.log 2>&1", 0, True) <> 0 Then
    MsgBox "The install failed. Check your internet connection and try again." & vbCrLf & "Details are in install.log.", vbCritical, "Attentix"
    WScript.Quit 1
  End If
End If

' Start the server hidden and do not wait (False). A second launch just opens the running one.
shell.Run "cmd /c node src\index.js >> server.log 2>&1", 0, False
