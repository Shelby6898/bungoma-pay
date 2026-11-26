import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { app } from './firebase'

export const db = getFirestore(app)

if (
  import.meta.env.DEV &&
  import.meta.env.VITE_USE_FIRESTORE_EMULATOR === 'true'
) {
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  console.info('Firestore connected to local emulator')
}
