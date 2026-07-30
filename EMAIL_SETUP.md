# Invoice PDF email setup

Every newly created invoice is emailed as a PDF attachment. The invoice is saved only after the mail server accepts the email, so a delivery setup problem does not create a duplicate billing record.

## Install the required packages

```powershell
cd "G:\WEBSITE\www.prabhustudios.com-main +billing security\www.prabhustudios.com-main"
npm install
```

## Gmail configuration

Use a Gmail App Password, not the normal Gmail password. Enable two-step verification on the sending Gmail account, then create an App Password in that account's Google security settings.

Set the following values in the PowerShell window before starting the server. Do not add the App Password to source code or commit it to GitHub.

```powershell
$env:SMTP_HOST = "smtp.gmail.com"
$env:SMTP_PORT = "465"
$env:SMTP_SECURE = "true"
$env:SMTP_USER = "your-sending-address@gmail.com"
$env:SMTP_PASS = "your-16-character-app-password"
$env:SMTP_FROM = "your-sending-address@gmail.com"
$env:BILLING_NOTIFICATION_EMAIL = "your-receiving-address@gmail.com"
npm start
```

`BILLING_NOTIFICATION_EMAIL` is the address that receives every invoice PDF. If it is omitted, the PDF is sent to the email address of the signed-in staff member.

## Render deployment

In Render, add the same values in the service's **Environment** page. Keep `SMTP_PASS` secret. After saving the values, redeploy the service.
