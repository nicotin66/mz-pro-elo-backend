# MZ Pro-ELO Crawler & Database

ManagerZone için tamamen bağımsız, açık kaynaklı ve 7/24 otomatik çalışan Pro-ELO sistemi.

## Özellikler
- **Tamamen Bağımsız:** Statsxente veya üçüncü parti sitelere bağımlı değildir.
- **Otomatik Keşif (Snowball Crawler):** Taranan her maçtaki rakip takımları otomatik keşfeder ve sıraya ekler.
- **Pro-ELO v1.0 Motoru:** 610 takım üzerinde doğrulanmış resmi lig çarpanları, farm koruması ve kupa ağırlıkları.
- **Supabase PostgreSQL:** Yüksek performanslı ve ücretsiz bulut veritabanı.
- **GitHub Actions:** Her 2 saatte bir ücretsiz olarak otomatik çalışır.

## GitHub Secrets
Deponuzun **Settings -> Secrets and variables -> Actions** kısmına şu 2 gizli anahtar tanımlanmalıdır:
1. `SUPABASE_URL`
2. `SUPABASE_SERVICE_KEY`
