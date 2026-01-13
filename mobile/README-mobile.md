# IMS Mobile (Option B - React Native/Expo)

This is a starter Expo app that talks to the existing Express/SQLite API. It includes login and simple dashboard views for admin/employee roles.

## Prereqs
- Node 18+
- Expo CLI (`npm install -g expo-cli`) or use `npx expo`
- Your API reachable at `https://modulr.pro` (or set `EXPO_PUBLIC_API_BASE`)

## Install & Run
```bash
cd mobile
npm install
EXPO_PUBLIC_API_BASE=https://modulr.pro npm start
# then press i for iOS simulator or scan the QR with Expo Go
```

## Notes
- Role header: the app sends `x-user-role` from the logged-in user to satisfy server RBAC.
- Default admin (if none exist): admin@example.com / ChangeMe123!
- Next steps: add real navigation (React Navigation), secure token storage (SecureStore/Keychain), offline caching, and feature screens (Operations, Catalog, History, Settings).***
