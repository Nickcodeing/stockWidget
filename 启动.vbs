Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
electron = dir & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(electron) Then
  MsgBox "未找到 Electron，请先在本目录执行 npm install。", 16, "A股悬浮行情"
  WScript.Quit 1
End If

sh.CurrentDirectory = dir
sh.Run """" & electron & """ """ & dir & """", 0, False
