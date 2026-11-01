
export interface Player {
  id: string
  number: string
  name: string
  active: boolean
}

export interface Team {
  id: string
  name: string
  createdAt: string
  players: Player[]
}

export type GameStatus = 'scheduled' | 'in-progress' | 'completed'

export type GameEventType =
  | 'shot'
  | 'freeThrow'
  | 'assist'
  | 'block'
  | 'steal'
  | 'offensiveRebound'
  | 'defensiveRebound'
  | 'turnover'
  | 'foul'
  | 'substitution'
  | 'timeout'

export interface GameEvent {
  id: string
  type: GameEventType
  teamId: string
  playerId?: string
  relatedPlayerId?: string
  points?: number
  made?: boolean
  quarter: number
  createdAt: string
  cancelled?: boolean
}

export interface Game {
  id: string
  name: string
  homeTeamId: string
  awayTeamId: string
  homeUniform: 'white' | 'dark'
  awayUniform: 'white' | 'dark'
  status: GameStatus
  currentQuarter: number
  events: GameEvent[]
  homeLineup?: string[]
  awayLineup?: string[]
  createdAt: string
  updatedAt: string
}

const DB_NAME = 'team-link-basketball'
const DB_VERSION = 3
const TEAM_STORE = 'teams'
const GAME_STORE = 'games'
const TRASH_STORE = 'trash'
const SNAPSHOT_STORE = 'restoreSnapshots'

export interface TrashItem { id: string; kind: 'team' | 'game'; name: string; deletedAt: string; data: Team | Game }
export interface RestoreSnapshot { id: string; createdAt: string; teams: Team[]; games: Game[] }

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(TEAM_STORE)) {
        db.createObjectStore(TEAM_STORE, { keyPath: 'id' })
      }

      if (!db.objectStoreNames.contains(GAME_STORE)) {
        db.createObjectStore(GAME_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(TRASH_STORE)) db.createObjectStore(TRASH_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' })
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => {
      reject(new Error('データベースの更新がブロックされました。ほかのタブを閉じてください。'))
    }
  })
}

export async function getTeams(): Promise<Team[]> {
  const db = await openDatabase()

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(TEAM_STORE, 'readonly')
      const request = transaction.objectStore(TEAM_STORE).getAll()

      request.onsuccess = () => resolve(request.result as Team[])
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

export async function saveTeam(team: Team): Promise<void> {
  const db = await openDatabase()

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(TEAM_STORE, 'readwrite')
      transaction.objectStore(TEAM_STORE).put(team)

      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

export async function deleteTeam(id: string): Promise<void> {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([TEAM_STORE, TRASH_STORE], 'readwrite')
      const store = tx.objectStore(TEAM_STORE)
      const req = store.get(id)
      req.onsuccess = () => {
        const team = req.result as Team | undefined
        if (team) {
          tx.objectStore(TRASH_STORE).put({ id: crypto.randomUUID(), kind: 'team', name: team.name, deletedAt: new Date().toISOString(), data: team } satisfies TrashItem)
          store.delete(id)
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}

export async function getGames(): Promise<Game[]> {
  const db = await openDatabase()

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(GAME_STORE, 'readonly')
      const request = transaction.objectStore(GAME_STORE).getAll()

      request.onsuccess = () => resolve(request.result as Game[])
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

// 同一タブ内の試合保存を順番に実行する。失敗しても次の処理を止めない。
const gameWriteQueues = new Map<string, Promise<void>>()

function enqueueGameWrite(gameId: string, operation: () => Promise<void>): Promise<void> {
  const previous = gameWriteQueues.get(gameId) ?? Promise.resolve()
  const task = previous.catch(() => undefined).then(operation)
  const settled = task.then(() => undefined, () => undefined)
  gameWriteQueues.set(gameId, settled)
  void settled.then(() => {
    if (gameWriteQueues.get(gameId) === settled) gameWriteQueues.delete(gameId)
  })
  return task
}

/** 同じ試合の保存を順序制御する。新規作成・全体更新用。 */
export function saveGame(game: Game): Promise<void> {
  return enqueueGameWrite(game.id, async () => {
    const db = await openDatabase()
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(GAME_STORE, 'readwrite')
        transaction.objectStore(GAME_STORE).put(game)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      db.close()
    }
  })
}

/** 最新の試合を読み込み、同じトランザクション内で更新する。連続入力時の記録消失を防ぐ。 */
export function updateGame(gameId: string, updater: (current: Game) => Game): Promise<void> {
  return enqueueGameWrite(gameId, async () => {
    const db = await openDatabase()
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(GAME_STORE, 'readwrite')
        const store = transaction.objectStore(GAME_STORE)
        const request = store.get(gameId)
        request.onsuccess = () => {
          try {
            const current = request.result as Game | undefined
            if (!current) throw new Error('更新対象の試合が見つかりません。')
            const updated = updater(current)
            if (updated.id !== gameId) throw new Error('試合IDは変更できません。')
            store.put(updated)
          } catch (error) {
            transaction.abort()
            failure = error
          }
        }
        let failure: unknown
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(failure ?? transaction.error)
        transaction.onabort = () => reject(failure ?? transaction.error)
      })
    } finally {
      db.close()
    }
  })
}

export function deleteGame(id: string): Promise<void> {
  return enqueueGameWrite(id, async () => {
    const db = await openDatabase()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([GAME_STORE, TRASH_STORE], 'readwrite')
        const store = tx.objectStore(GAME_STORE)
        const req = store.get(id)
        req.onsuccess = () => {
          const game = req.result as Game | undefined
          if (game) {
            tx.objectStore(TRASH_STORE).put({ id: crypto.randomUUID(), kind: 'game', name: game.name, deletedAt: new Date().toISOString(), data: game } satisfies TrashItem)
            store.delete(id)
          }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally { db.close() }
  })
}

export async function getTrash(): Promise<TrashItem[]> {
  const db = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TRASH_STORE, 'readonly')
      const req = tx.objectStore(TRASH_STORE).getAll()
      req.onsuccess = () => resolve((req.result as TrashItem[]).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)))
      req.onerror = () => reject(req.error)
    })
  } finally { db.close() }
}

export async function restoreTrashItem(trashId: string): Promise<void> {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([TRASH_STORE, TEAM_STORE, GAME_STORE], 'readwrite')
      const trash = tx.objectStore(TRASH_STORE)
      const req = trash.get(trashId)
      let error: Error | undefined
      req.onsuccess = () => {
        const item = req.result as TrashItem | undefined
        if (!item) { error = new Error('ゴミ箱のデータが見つかりません。'); tx.abort(); return }
        const target = tx.objectStore(item.kind === 'team' ? TEAM_STORE : GAME_STORE)
        const exists = target.get((item.data as Team | Game).id)
        exists.onsuccess = () => {
          if (exists.result) { error = new Error('同じIDのデータが既にあります。'); tx.abort(); return }
          target.put(item.data)
          trash.delete(trashId)
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(error ?? tx.error)
      tx.onabort = () => reject(error ?? tx.error)
    })
  } finally { db.close() }
}

export async function permanentlyDeleteTrashItem(trashId: string): Promise<void> {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(TRASH_STORE, 'readwrite')
      tx.objectStore(TRASH_STORE).delete(trashId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}

export async function getRestoreSnapshots(): Promise<RestoreSnapshot[]> {
  const db = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(SNAPSHOT_STORE, 'readonly').objectStore(SNAPSHOT_STORE).getAll()
      req.onsuccess = () => resolve((req.result as RestoreSnapshot[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
      req.onerror = () => reject(req.error)
    })
  } finally { db.close() }
}

export function createDefaultPlayers(): Player[] {
  const numbers = [
    '00',
    '0',
    ...Array.from({ length: 99 }, (_, index) => String(index + 1)),
  ]

  return numbers.map((number) => ({
    id: crypto.randomUUID(),
    number,
    name: `#${number}`,
    active: true,
  }))
}

/** バックアップからチーム・試合データをまとめて置き換える。単一トランザクションで処理する。 */
/** 復元直前の全データを同じIndexedDBトランザクション内に退避し、復元と一緒に確定する。 */
export async function replaceAllData(teams: Team[], games: Game[]): Promise<void> {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([TEAM_STORE, GAME_STORE, SNAPSHOT_STORE], 'readwrite')
      const teamStore = tx.objectStore(TEAM_STORE)
      const gameStore = tx.objectStore(GAME_STORE)
      const snapshotStore = tx.objectStore(SNAPSHOT_STORE)
      const oldTeams = teamStore.getAll()
      const oldGames = gameStore.getAll()
      let ready = 0
      const proceed = () => {
        if (++ready !== 2) return
        snapshotStore.put({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), teams: oldTeams.result as Team[], games: oldGames.result as Game[] } satisfies RestoreSnapshot)
        teamStore.clear()
        gameStore.clear()
        teams.forEach(team => teamStore.put(team))
        games.forEach(game => gameStore.put(game))
      }
      oldTeams.onsuccess = proceed
      oldGames.onsuccess = proceed
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}
