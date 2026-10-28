; Incluído pelo electron-builder no instalador NSIS.
; Cria a regra do firewall que libera o Telinha só para a rede do Tailscale (100.64.0.0/10).
; Pede o "Sim" do Windows uma vez só: se a regra já existe (atualizações), não pergunta de novo.
; Antes apaga as regras de entrada do Telinha.exe (um "Cancelar" no aviso do Windows cria bloqueios).
; A mesma regra é criada pelo botão "Liberar no firewall" do app (lib/firewall.js).
!macro customInstall
  nsExec::ExecToStack '"$SYSDIR\netsh.exe" advfirewall firewall show rule name=Telinha-Tailscale'
  Pop $0
  Pop $1
  StrCmp $0 "0" telinha_fw_done
  ExecShell "runas" "$SYSDIR\cmd.exe" '/c netsh advfirewall firewall delete rule name=all dir=in program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" & netsh advfirewall firewall add rule name=Telinha-Tailscale dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" remoteip=100.64.0.0/10 profile=any enable=yes' SW_HIDE
  telinha_fw_done:
!macroend
