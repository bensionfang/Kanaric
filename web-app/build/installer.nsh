; 裝完彈一個「安裝完成」視窗。搭配 package.json 的 nsis.runAfterFinish:false —— 不自動開 app。
!macro customInstall
  MessageBox MB_OK "Kanaric 安裝完成"
!macroend
