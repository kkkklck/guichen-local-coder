$ErrorActionPreference='Stop'
$source=@"
using System;
using System.Runtime.InteropServices;
using System.Security;
public static class LocalCoderCredWrite {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL {
  public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize;
  public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount;
  public IntPtr Attributes; public string TargetAlias; public string UserName;
 }
 [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
 public static bool Save(SecureString secret) {
  IntPtr bstr=Marshal.SecureStringToBSTR(secret); IntPtr blob=IntPtr.Zero;
  try {
   int bytes=secret.Length*2; blob=Marshal.AllocHGlobal(bytes); byte[] data=new byte[bytes]; Marshal.Copy(bstr,data,0,bytes); Marshal.Copy(data,0,blob,bytes); Array.Clear(data,0,data.Length);
   CREDENTIAL c=new CREDENTIAL(); c.Type=1; c.TargetName="GuichenLocalCoder:RuntimeAPIKey"; c.CredentialBlob=blob; c.CredentialBlobSize=(UInt32)bytes; c.Persist=2; c.UserName="OpenAI Runtime API";
   return CredWrite(ref c,0);
  } finally { if(blob!=IntPtr.Zero){ for(int i=0;i<secret.Length*2;i++) Marshal.WriteByte(blob,i,0); Marshal.FreeHGlobal(blob); } Marshal.ZeroFreeBSTR(bstr); }
 }
}
"@
Add-Type -TypeDefinition $source
$secret=Read-Host 'Paste Runtime API Key (hidden input)' -AsSecureString
if($secret.Length -lt 20){ throw 'The provided credential is too short.' }
if(-not [LocalCoderCredWrite]::Save($secret)){ throw 'Windows Credential Manager could not save the runtime credential.' }
$secret.Dispose()
Write-Output 'Runtime API credential stored in Windows Credential Manager.'
