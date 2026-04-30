import { initializeApp, FirebaseApp, getApps, FirebaseError } from 'firebase/app';
import {
  getAuth,
  Auth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  GithubAuthProvider,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User,
  NextOrObserver,
} from 'firebase/auth';
import {
  getFirestore,
  Firestore,
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  QueryConstraint,
  DocumentData,
  QueryDocumentSnapshot,
  SnapshotOptions,
} from 'firebase/firestore';
import {
  getStorage,
  FirebaseStorage,
  ref,
  uploadBytes,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
  StorageReference,
} from 'firebase/storage';
import {
  getDatabase,
  Database,
  ref as rtdbRef,
  set,
  get,
  onValue,
  push,
  update,
  remove,
  serverTimestamp,
} from 'firebase/database';
import log from 'electron-log';

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  databaseURL?: string;
}

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerId: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  role: 'user' | 'admin' | 'developer';
  createdAt: number;
  lastLogin: number;
  preferences: {
    theme: 'light' | 'dark' | 'system';
    model: string;
    autoSave: boolean;
  };
}

export interface Checkpoint {
  id: string;
  userId: string;
  sessionId: string;
  state: Record<string, any>;
  description: string;
  createdAt: number;
}

class FirebaseService {
  private app: FirebaseApp | null = null;
  private auth: Auth | null = null;
  private db: Firestore | null = null;
  private storage: FirebaseStorage | null = null;
  private rtdb: Database | null = null;
  private currentUser: User | null = null;
  private unsubscribes: (() => void)[] = [];
  private isInitialized: boolean = false;

  async initialize(config: FirebaseConfig): Promise<boolean> {
    if (this.isInitialized) {
      log.info('Firebase already initialized');
      return true;
    }

    try {
      if (getApps().length === 0) {
        this.app = initializeApp(config);
      } else {
        this.app = getApps()[0];
      }

      this.auth = getAuth(this.app);
      this.db = getFirestore(this.app);
      this.storage = getStorage(this.app);

      if (config.databaseURL) {
        this.rtdb = getDatabase(this.app);
      }

      this.setupAuthObserver();

      this.isInitialized = true;
      log.info('Firebase initialized successfully');
      return true;
    } catch (error) {
      log.error('Firebase initialization failed:', error);
      return false;
    }
  }

  private setupAuthObserver(): void {
    if (!this.auth) return;

    onAuthStateChanged(this.auth, (user) => {
      this.currentUser = user;
      log.info('Auth state changed:', user?.uid);
    });
  }

  async signInWithEmail(email: string, password: string): Promise<AuthUser | null> {
    if (!this.auth) throw new Error('Firebase not initialized');

    try {
      const result = await signInWithEmailAndPassword(this.auth, email, password);
      return this.convertUser(result.user);
    } catch (error) {
      log.error('Email sign-in failed:', error);
      throw error;
    }
  }

  async signUpWithEmail(email: string, password: string): Promise<AuthUser | null> {
    if (!this.auth) throw new Error('Firebase not initialized');

    try {
      const result = await createUserWithEmailAndPassword(this.auth, email, password);
      await this.createUserProfile(result.user);
      return this.convertUser(result.user);
    } catch (error) {
      log.error('Email sign-up failed:', error);
      throw error;
    }
  }

  async signInWithGoogle(): Promise<AuthUser | null> {
    if (!this.auth) throw new Error('Firebase not initialized');

    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(this.auth, provider);
      await this.ensureUserProfile(result.user);
      return this.convertUser(result.user);
    } catch (error) {
      log.error('Google sign-in failed:', error);
      throw error;
    }
  }

  async signInWithGitHub(): Promise<AuthUser | null> {
    if (!this.auth) throw new Error('Firebase not initialized');

    try {
      const provider = new GithubAuthProvider();
      provider.addScope('repo');
      provider.addScope('read:user');
      const result = await signInWithPopup(this.auth, provider);
      await this.ensureUserProfile(result.user);
      return this.convertUser(result.user);
    } catch (error) {
      log.error('GitHub sign-in failed:', error);
      throw error;
    }
  }

  async signOut(): Promise<void> {
    if (!this.auth) throw new Error('Firebase not initialized');

    await firebaseSignOut(this.auth);
    this.unsubscribes.forEach((unsub) => unsub());
    this.unsubscribes = [];
    log.info('User signed out');
  }

  private convertUser(user: User): AuthUser {
    return {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      providerId: user.providerId,
    };
  }

  private async createUserProfile(user: User): Promise<void> {
    if (!this.db) return;

    const profile: Omit<UserProfile, 'uid'> = {
      email: user.email || '',
      displayName: user.displayName || 'User',
      photoURL: user.photoURL || undefined,
      role: 'user',
      createdAt: Date.now(),
      lastLogin: Date.now(),
      preferences: {
        theme: 'dark',
        model: 'qwen/qwen3-coder-32b',
        autoSave: true,
      },
    };

    await setDoc(doc(this.db, 'users', user.uid), profile);
  }

  private async ensureUserProfile(user: User): Promise<void> {
    if (!this.db) return;

    const docRef = doc(this.db, 'users', user.uid);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      await this.createUserProfile(user);
    } else {
      await updateDoc(docRef, { lastLogin: Date.now() });
    }
  }

  async getUserProfile(uid: string): Promise<UserProfile | null> {
    if (!this.db) return null;

    const docRef = doc(this.db, 'users', uid);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
      return { uid, ...docSnap.data() } as UserProfile;
    }
    return null;
  }

  async updateUserProfile(uid: string, data: Partial<UserProfile>): Promise<void> {
    if (!this.db) return;

    const docRef = doc(this.db, 'users', uid);
    await updateDoc(docRef, data);
  }

  onAuthChange(callback: NextOrObserver<User | null>): () => void {
    if (!this.auth) return () => {};

    const unsubscribe = onAuthStateChanged(this.auth, callback);
    this.unsubscribes.push(unsubscribe);
    return unsubscribe;
  }

  getCurrentUser(): User | null {
    return this.currentUser;
  }

  async saveChatMessage(message: Omit<ChatMessage, 'id'>): Promise<string> {
    if (!this.db) throw new Error('Firebase not initialized');

    const docRef = doc(collection(this.db, 'messages'));
    await setDoc(docRef, message);
    return docRef.id;
  }

  async getChatMessages(sessionId: string, maxMessages: number = 100): Promise<ChatMessage[]> {
    if (!this.db) return [];

    const q = query(
      collection(this.db, 'messages'),
      where('sessionId', '==', sessionId),
      orderBy('timestamp', 'desc'),
      limit(maxMessages)
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as ChatMessage[];
  }

  onChatMessages(
    sessionId: string,
    callback: (messages: ChatMessage[]) => void
  ): () => void {
    if (!this.db) return () => {};

    const q = query(
      collection(this.db, 'messages'),
      where('sessionId', '==', sessionId),
      orderBy('timestamp', 'desc'),
      limit(100)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const messages = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as ChatMessage[];
      callback(messages);
    });

    this.unsubscribes.push(unsubscribe);
    return unsubscribe;
  }

  async saveCheckpoint(checkpoint: Omit<Checkpoint, 'id'>): Promise<string> {
    if (!this.db) throw new Error('Firebase not initialized');

    const docRef = doc(collection(this.db, 'checkpoints'));
    await setDoc(docRef, checkpoint);
    return docRef.id;
  }

  async getCheckpoints(userId: string): Promise<Checkpoint[]> {
    if (!this.db) return [];

    const q = query(
      collection(this.db, 'checkpoints'),
      where('userId', '==', userId),
      orderBy('createdAt', 'desc')
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as Checkpoint[];
  }

  async uploadFile(
    path: string,
    data: Blob | ArrayBuffer,
    metadata?: Record<string, any>
  ): Promise<string> {
    if (!this.storage) throw new Error('Firebase not initialized');

    const storageRef = ref(this.storage, path);
    await uploadBytes(storageRef, data, metadata);
    return await getDownloadURL(storageRef);
  }

  async uploadFileWithProgress(
    path: string,
    data: Blob | ArrayBuffer,
    onProgress: (progress: number) => void,
    metadata?: Record<string, any>
  ): Promise<string> {
    if (!this.storage) throw new Error('Firebase not initialized');

    const storageRef = ref(this.storage, path);
    const uploadTask = uploadBytesResumable(storageRef, data, metadata);

    return new Promise((resolve, reject) => {
      uploadTask.on(
        'state_changed',
        (snapshot) => {
          const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
          onProgress(progress);
        },
        (error) => {
          log.error('Upload failed:', error);
          reject(error);
        },
        async () => {
          const url = await getDownloadURL(uploadTask.snapshot.ref);
          resolve(url);
        }
      );
    });
  }

  async deleteFile(path: string): Promise<void> {
    if (!this.storage) throw new Error('Firebase not initialized');

    const storageRef = ref(this.storage, path);
    await deleteObject(storageRef);
  }

  async getFileUrl(path: string): Promise<string> {
    if (!this.storage) throw new Error('Firebase not initialized');

    const storageRef = ref(this.storage, path);
    return await getDownloadURL(storageRef);
  }

  async setRealtimeValue(path: string, value: any): Promise<void> {
    if (!this.rtdb) throw new Error('Realtime database not initialized');

    await set(rtdbRef(this.rtdb, path), {
      ...value,
      _timestamp: serverTimestamp(),
    });
  }

  async getRealtimeValue(path: string): Promise<any> {
    if (!this.rtdb) throw new Error('Realtime database not initialized');

    const snapshot = await get(rtdbRef(this.rtdb, path));
    return snapshot.val();
  }

  onRealtimeValue(path: string, callback: (value: any) => void): () => void {
    if (!this.rtdb) return () => {};

    const reference = rtdbRef(this.rtdb, path);
    const unsubscribe = onValue(reference, (snapshot) => {
      callback(snapshot.val());
    });

    this.unsubscribes.push(unsubscribe);
    return unsubscribe;
  }

  async pushRealtimeList(path: string, value: any): Promise<string> {
    if (!this.rtdb) throw new Error('Realtime database not initialized');

    const listRef = rtdbRef(this.rtdb, path);
    const newRef = push(listRef);
    await set(newRef, {
      ...value,
      _timestamp: serverTimestamp(),
    });
    return newRef.key || '';
  }

  async updateRealtime(path: string, value: any): Promise<void> {
    if (!this.rtdb) throw new Error('Realtime database not initialized');

    await update(rtdbRef(this.rtdb, path), {
      ...value,
      _updatedAt: serverTimestamp(),
    });
  }

  async removeRealtime(path: string): Promise<void> {
    if (!this.rtdb) throw new Error('Realtime database not initialized');

    await remove(rtdbRef(this.rtdb, path));
  }

  cleanup(): void {
    this.unsubscribes.forEach((unsub) => unsub());
    this.unsubscribes = [];
    log.info('Firebase service cleaned up');
  }
}

export const firebaseService = new FirebaseService();
export default firebaseService;