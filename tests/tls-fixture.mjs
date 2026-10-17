import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Ephemeral self-signed certificate, trusted only by this test client. No OS trust-store changes.
export function testCertificate(directory) {
  if (process.platform === 'win32') {
    const script = `
      $ErrorActionPreference = 'Stop'
      $key = [System.Security.Cryptography.RSA]::Create(2048)
      $req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $key, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
      $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
      $san.AddDnsName('localhost')
      $san.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
      $req.CertificateExtensions.Add($san.Build())
      $cert = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(2))
      [IO.File]::WriteAllText((Join-Path $env:DELTA_TEST_TLS_DIR 'cert.pem'), $cert.ExportCertificatePem())
      [IO.File]::WriteAllText((Join-Path $env:DELTA_TEST_TLS_DIR 'key.pem'), $key.ExportPkcs8PrivateKeyPem())
      $cert.Dispose()
      $key.Dispose()
    `;
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, DELTA_TEST_TLS_DIR: directory }, stdio: 'pipe' });
  } else {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem')], { stdio: 'pipe' });
  }
  return { key: readFileSync(path.join(directory, 'key.pem')), cert: readFileSync(path.join(directory, 'cert.pem')) };
}
