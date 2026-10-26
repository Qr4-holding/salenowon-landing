# Sale Now On — coming-soon landing page

salenowon.co.uk: launch video, SALES ALERTS sign-up and retailer/agency early-access form.
Plain Node (one dependency: `pg`) serving `public/`, storing sign-ups in PostgreSQL.

- `/admin`: sign-ups list with CSV downloads (basic auth: admin / ADMIN_PASSWORD).
- Deploy: `docker-compose.yml` runs on the Hostinger VPS (Docker manager project `salenowon`).
  The web container clones `main` on start, so push, then restart the project.
