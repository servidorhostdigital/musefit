# MuseFit on Vercel + Supabase

The repository is configured as a Vercel Services project:

- `frontend/` is the public Vite service.
- `api/` is the Node container service and receives `/api/*` requests.
- `vercel.json` routes both services through the same MuseFit domain.

The API keeps its existing file-oriented data model so the self-hosted Docker
deployment remains compatible. In a Vercel container the local filesystem is
ephemeral, so `api/supabase-persistence.js` hydrates `DATA_DIR` from a private
Supabase Storage bucket at boot and mirrors later file changes back to it. This
includes account data, sync state, passkeys, push keys, integrations and media.

Configure these variables on the **API service only**:

```text
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key
SUPABASE_STORAGE_BUCKET=musefit-data
DATA_DIR=/tmp/musefit-data
ORIGIN=https://musefit.vercel.app
RP_ID=musefit.vercel.app
RP_NAME=MuseFit
FIRST_USER_ADMIN=1
```

The bucket is created privately on the first API boot. The service-role key
must never be placed in a `VITE_*` variable, committed to Git, or sent to the
browser. The frontend uses same-origin `/api` routes and therefore does not
need a Supabase secret.
