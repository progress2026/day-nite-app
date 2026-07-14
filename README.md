# Day-Nite · Shipment Log

Bitácora de envíos para Day Nite Neon Signs. React + Firebase (Firestore) + Vercel
— el mismo stack que la app de DR Appliance.

- **Frontend:** React (Vite)
- **Base de datos compartida en tiempo real:** Firestore (todo el equipo ve lo mismo al instante)
- **Lectura de documentos con IA:** función serverless en Vercel (`/api/scan`) que llama a Claude con la API key protegida en el servidor
- **Hosting:** Vercel

---

## 1. Correr en local

Necesitas Node 18+.

```bash
npm install
cp .env.example .env      # y llena los valores (ver paso 2 y 3)
npm run dev               # abre http://localhost:5173
```

> Nota: la lectura con IA (`/api/scan`) corre en Vercel. En local puedes usar
> `vercel dev` (con la CLI de Vercel) para probar la función; con `npm run dev`
> solo, el formulario manual funciona pero el escaneo devolverá error hasta
> desplegar o usar `vercel dev`.

## 2. Firebase (base de datos)

1. Entra a https://console.firebase.google.com y crea un proyecto (o reutiliza uno).
2. **Build > Firestore Database > Create database.** Empieza en *test mode* para
   probar rápido (ver nota de seguridad abajo).
3. **Project settings (⚙️) > General > Your apps > Web app (`</>`)** y copia la
   configuración (apiKey, authDomain, projectId, etc.).
4. Pega esos valores en `.env` (las variables `VITE_FIREBASE_*`).

La app guarda todo en una colección llamada `shipments`. No hay que crearla a mano:
se crea sola con el primer registro (o al tocar "Load examples").

## 3. Anthropic (lectura con IA)

1. Consigue tu API key en https://console.anthropic.com (la misma del chatbot sirve).
2. Ponla en `.env` como `ANTHROPIC_API_KEY` (SIN el prefijo `VITE_` — esta clave
   vive solo en el servidor, nunca en el navegador).

## 4. Desplegar en Vercel

1. Sube el proyecto a un repo de GitHub (igual que la app de DR Appliance).
2. En https://vercel.com > **Add New > Project** e importa el repo.
3. Vercel detecta Vite automáticamente. En **Environment Variables** agrega TODAS
   las de tu `.env`:
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_STORAGE_BUCKET`
   - `VITE_FIREBASE_MESSAGING_SENDER_ID`
   - `VITE_FIREBASE_APP_ID`
   - `ANTHROPIC_API_KEY`
4. **Deploy.** Vercel te da la URL pública. La función `/api/scan` se despliega
   sola (está en la carpeta `api/`).

Cada push a GitHub redepliega automáticamente.

---

## Seguridad (importante antes de uso real)

Firestore en *test mode* deja leer/escribir a cualquiera con la URL. Está bien para
probar, pero **antes de usarlo en serio** conviene agregar login (Firebase Auth, como
en la app de DR Appliance) y reglas de Firestore que solo permitan acceso a usuarios
autenticados. Ejemplo de regla mínima con Auth:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /shipments/{id} {
      allow read, write: if request.auth != null;
    }
  }
}
```

## Modelo de datos (colección `shipments`)

Cada documento:

```
{
  workOrder: string,
  customer: string,
  lineItems: [ { qty: string, description: string } ],
  destination: string,
  date: string,            // "YYYY-MM-DD"
  carrier: string,
  trackingNumber: string,
  loggedBy: string,
  notes: string,
  checklist: [ { label: string, done: boolean } ] | null,
  createdAt: string,       // ISO
  updatedAt: string        // ISO
}
```

## Estructura

```
api/scan.js        Función serverless: lee el documento con Claude
src/App.jsx        La app (UI + lógica, conectada a Firestore)
src/firebase.js    Inicialización de Firebase
src/logo.js        Logo de Day-Nite embebido
src/main.jsx       Punto de entrada de React
```
