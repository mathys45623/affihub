# AffiHub — Instructions de déploiement

## Structure
```
affihub/
├── api/
│   └── server.js       ← Le serveur backend
├── public/
│   └── index.html      ← Le frontend
├── package.json
├── vercel.json
└── README.md
```

## Déploiement sur Vercel

1. Va sur github.com → New repository → nom: `affihub` → Create
2. Upload tous les fichiers
3. Va sur vercel.com → New Project → importe le repo GitHub
4. Dans "Environment Variables" ajoute :
   - SUPABASE_URL = https://rhrhtqmgqwkdcrcglkys.supabase.co
   - SUPABASE_KEY = (ta clé anon)
   - JWT_SECRET = affihub_secret_2024
5. Deploy !

## URL Postback pour les partenaires
https://TON-SITE.vercel.app/postback?aff=LIEN_ID&amount=10&secret=affihub2024
