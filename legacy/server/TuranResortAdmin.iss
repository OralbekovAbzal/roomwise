; Inno Setup 6 script for TuranResortAdmin
; Сборка: сначала запустите build_installer.bat или вручную:
;   1. pyinstaller TuranResortAdmin.spec
;   2. iscc TuranResortAdmin.iss

#define MyAppName "TuranResort Admin"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "TuranResort"
#define MyAppExeName "TuranResortAdmin.exe"
#define MyAppAssocName "TuranResort Admin"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
; Результат установщика — один .exe в папке Output
OutputDir=Output
OutputBaseFilename=TuranResortAdmin_Setup_{#MyAppVersion}
SetupIconFile=
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Чтобы при обновлении не спрашивать снова каталог
UsePreviousAppDir=yes

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Содержимое папки dist\TuranResortAdmin\ (exe и все библиотеки от PyInstaller)
Source: "dist\TuranResortAdmin\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Конфиг цен — чтобы на других ПК сразу были настройки (при необходимости заменить)
Source: "prices.json"; DestDir: "{app}"; Flags: ignoreversion
; Опционально: шаблон ключа API (пустой или с подсказкой) — пользователь заполнит сам
; Source: "gemini_api_key.txt"; DestDir: "{app}"; Flags: ignoreversion uninsneveruninstall

[Dirs]
; Папка для логов/данных при необходимости
; Name: "{app}\data"; Permissions: users-full

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; Не запускать приложение после установки по умолчанию
; Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; При удалении можно очистить только установленные файлы; цены и ключ пользователь может сохранить
; Type: files; Name: "{app}\gemini_api_key.txt"

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
end;
