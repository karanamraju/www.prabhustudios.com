# PRABHU STUDIO — secure billing portal

This version adds a staff-only billing dashboard to the supplied studio landing page. It includes server-side password hashing (scrypt), HTTP-only login cookies, CSRF protection, login rate limiting, security headers, invoice creation, and paid-status tracking.

## Run locally

Use Node.js 20 or later. On first launch, set a unique owner email and a strong password (at least 12 characters with uppercase, lowercase, and a number). The password is hashed before it is written to disk.

```powershell
$env:STUDIO_ADMIN_EMAIL = "owner@prabhustudio.in"
$env:STUDIO_ADMIN_PASSWORD = "Use-a-unique-strong-password-123"
node .\server.js
```

Open `http://localhost:3000`, choose **Staff sign in**, then use the email and password configured above.

The generated `data/` folder holds the password hash and billing records. Keep it private, back it up securely, and do not commit it to source control.

## Use the billing dashboard

1. Sign in with the owner email and password that you configured at first launch.
2. Create an invoice with the client, service, amount, and due date.
3. Use the search box and status filter to find invoices quickly. Overdue invoices are calculated from their due date.
4. Once payment is confirmed outside the website, select **Mark paid**. The dashboard then updates the received and outstanding totals.

The portal records invoice status only. It does not charge a card, UPI account, or bank account.

## Production notes

- Set `NODE_ENV=production` and serve the app only over HTTPS; this enables the `Secure` cookie flag.
- Place the app behind a TLS-enabled reverse proxy and set a restrictive firewall rule.
- Use a managed database and persistent session store before hosting for multiple staff members or multiple server instances.
- The **Mark paid** control records payment status only. It never accepts card, UPI, or bank details. Connect a compliant processor such as Razorpay or Stripe using server-side credentials and webhook signature verification before accepting payments online.
