import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  createDefaultPlayers,
  deleteGame,
  deleteTeam,
  getGames,
  getTeams,
  saveGame,
  updateGame,
  saveTeam,
  replaceAllData,
  getTrash,
  restoreTrashItem,
  permanentlyDeleteTrashItem,
  getRestoreSnapshots,
  type TrashItem,
  type RestoreSnapshot,
  type Game,
  type Team,
} from './lib/database'

type Page = 'teams' | 'games' | 'stats' | 'backup' | 'game-detail' | 'game-record'
type DatedGame = Game & { gameDate?: string }
const formatGameDate = (date: string) => date.slice(0, 10).replace(/-/g, '/')
const todayLocal = () => {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
type RecordView = 'official' | 'original'

// 背番号は 1〜99 → 0 → 00 の順に並べる（選手IDや保存データは変更しない）
const sortPlayersForSelection = <T extends { number: string | number }>(players: T[]): T[] => {
  const rank = (number: string | number): number => {
    const value = String(number)
    if (value === '0') return 100
    if (value === '00') return 101
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 99 ? parsed : 102
  }
  return [...players].sort((a, b) => rank(a.number) - rank(b.number))
}

// 当該クォーターのチームファウルを最大4マスで表示する。
function TeamFoulIndicator({ count }: { count: number }) {
  const danger = count >= 5
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap font-black ${danger ? 'text-red-500' : 'text-yellow-300'}`} aria-label={`チームファウル${count}回${count >= 4 ? ' ボーナス' : ''}`}>
    <span className="tracking-[2px]">{'■'.repeat(Math.min(4, count))}</span>
    {count >= 4 && <span>BONUS</span>}
  </span>
}

// 延長戦に進んだ場合のみ、該当する延長クォーターを表示する
const visibleQuarters = (game: Game): number[] => {
  const lastQuarter = Math.min(6, Math.max(4, game.currentQuarter, ...game.events.filter(e => !e.cancelled).map(e => e.quarter)))
  return Array.from({ length: lastQuarter }, (_, i) => i + 1)
}



function App() {
  const [page, setPage] = useState<Page>('teams')
  const [teams, setTeams] = useState<Team[]>([])
  // お気に入りは端末内に保存（既存のチーム・試合データ形式は変更しない）
  const [favoriteTeamIds, setFavoriteTeamIds] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('team-link-favorite-team-ids') ?? '[]')
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  })
  const [games, setGames] = useState<Game[]>([])
  const [statsGameIndex, setStatsGameIndex] = useState(-1)
  const [statsFullscreen, setStatsFullscreen] = useState(false)
  const [pdfPreparing, setPdfPreparing] = useState(false)
  const [preparedPdf, setPreparedPdf] = useState<{ gameId: string; file: File } | null>(null)
  const statsSheetContainerRef = useRef<HTMLDivElement>(null)
  const [statsSheetWidth, setStatsSheetWidth] = useState(1000)
  useEffect(() => {
    const element = statsSheetContainerRef.current
    if (page !== 'stats' || !element) return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      if (width && width > 0) setStatsSheetWidth(width)
    })
    observer.observe(element)
    setStatsSheetWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [page])
  const statsSheetScale = Math.min(1.6, statsSheetWidth / 1000)
  useEffect(() => {
    if (!statsFullscreen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setStatsFullscreen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [statsFullscreen])
  const [trash, setTrash] = useState<TrashItem[]>([])
  const [restoreSnapshots, setRestoreSnapshots] = useState<RestoreSnapshot[]>([])
  const refreshSequence = useRef(0)
  const [teamName, setTeamName] = useState('')
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null)
  const [gameName, setGameName] = useState('')
  const [gameDate, setGameDate] = useState(todayLocal)
  const [homeTeamId, setHomeTeamId] = useState('')
  const [awayTeamId, setAwayTeamId] = useState('')
  const [homeUniform, setHomeUniform] = useState<'white' | 'dark'>('white')
  const [awayUniform, setAwayUniform] = useState<'white' | 'dark'>('dark')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null)
  const [homeLineup, setHomeLineup] = useState<string[]>([])
  const [awayLineup, setAwayLineup] = useState<string[]>([])
  const [lineupSetupQuarter, setLineupSetupQuarter] = useState(1)
  const [substitutionTeamId, setSubstitutionTeamId] = useState<string | null>(null)
  const [substitutionLineup, setSubstitutionLineup] = useState<string[]>([])
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>('')
  const [recordView, setRecordView] = useState<RecordView>('official')
  const [historyModalOpen, setHistoryModalOpen] = useState(false)
  const [historyWhitePlayer, setHistoryWhitePlayer] = useState<string>('all')
  const [historyDarkPlayer, setHistoryDarkPlayer] = useState<string>('all')
  const [freeThrowModalOpen, setFreeThrowModalOpen] = useState(false)
  const [freeThrowCount, setFreeThrowCount] = useState<1 | 2 | 3>(2)
  const [freeThrowResults, setFreeThrowResults] = useState<Array<boolean | null>>([null, null])
  const [timeoutLimit, setTimeoutLimit] = useState<number>(() => { const value = Number(localStorage.getItem('team-link-timeout-limit') ?? '1'); return [1, 2, 3].includes(value) ? value : 1 })

  function toggleFavoriteTeam(teamId: string) {
    setFavoriteTeamIds(current => {
      const next = current.includes(teamId) ? current.filter(id => id !== teamId) : [...current, teamId]
      try { localStorage.setItem('team-link-favorite-team-ids', JSON.stringify(next)) } catch (error) { console.error('お気に入りの保存に失敗しました', error) }
      return next
    })
  }

  async function refreshData() {
    const sequence = ++refreshSequence.current
    const [savedTeams, savedGames] = await Promise.all([getTeams(), getGames()])
    if (sequence !== refreshSequence.current) return
    setTeams(savedTeams)
    setGames(
      savedGames.sort((a, b) => {
        const dateOf = (game: Game) => (game as DatedGame).gameDate || game.createdAt.slice(0, 10)
        const dateComparison = dateOf(b).localeCompare(dateOf(a))
        if (dateComparison !== 0) return dateComparison
        const statusOrder: Record<Game['status'], number> = {
          scheduled: 0,
          'in-progress': 1,
          completed: 2,
        }
        const statusComparison = statusOrder[a.status] - statusOrder[b.status]
        if (statusComparison !== 0) return statusComparison
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      }),
    )
  }

  useEffect(() => {
    async function loadData() {
      try {
        await refreshData()
      } catch (error) {
        console.error(error)
        setMessage('データを読み込めませんでした。ページを再読み込みしてください。')
      } finally {
        setLoading(false)
      }
    }
    void loadData()
  }, [])

  async function handleCreateTeam() {
    const name = teamName.trim()
    if (!name) {
      setMessage('チーム名を入力してください。')
      return
    }

    setSaving(true)
    setMessage('')
    const team: Team = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      players: createDefaultPlayers(),
    }

    try {
      await saveTeam(team)
      await refreshData()
      setTeamName('')
      setExpandedTeamId(team.id)
      setMessage(`${name} を保存しました。`)
    } catch (error) {
      console.error(error)
      setMessage('チームを保存できませんでした。')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteTeam(team: Team) {
    const usedByGame = games.some(
      (game) => game.homeTeamId === team.id || game.awayTeamId === team.id,
    )
    if (usedByGame) {
      setMessage('このチームは試合に登録されています。先に関連する試合を削除してください。')
      return
    }
    if (!window.confirm(`「${team.name}」をゴミ箱に移動しますか？`)) return

    try {
      await deleteTeam(team.id)
      await refreshData()
      setMessage(`${team.name} をゴミ箱に移動しました。`)
    } catch (error) {
      console.error(error)
      setMessage('チームを削除できませんでした。')
    }
  }

  async function handlePlayerNameChange(
    team: Team,
    playerId: string,
    newName: string,
  ) {
    const updatedTeam: Team = {
      ...team,
      players: team.players.map((player) =>
        player.id === playerId ? { ...player, name: newName } : player,
      ),
    }

    try {
      await saveTeam(updatedTeam)
      setTeams((current) =>
        current.map((item) => (item.id === team.id ? updatedTeam : item)),
      )
      setMessage('選手名を保存しました。')
    } catch (error) {
      console.error(error)
      setMessage('選手名を保存できませんでした。')
    }
  }

  async function handleCreateGame() {
    if (teams.length < 2) {
      setMessage('試合を作成するには、先に2チーム以上登録してください。')
      return
    }
    if (!homeTeamId || !awayTeamId) {
      setMessage('ホームチームとアウェイチームを選択してください。')
      return
    }
    if (homeTeamId === awayTeamId) {
      setMessage('異なるチームを選択してください。')
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate) || Number.isNaN(new Date(`${gameDate}T12:00:00`).getTime())) {
      setMessage('試合日を入力してください。')
      return
    }
    if (homeUniform === awayUniform) {
      setMessage('両チームのユニフォームの色を分けてください。')
      return
    }

    setSaving(true)
    setMessage('')
    const now = new Date().toISOString()
    const homeTeam = teams.find((team) => team.id === homeTeamId)
    const awayTeam = teams.find((team) => team.id === awayTeamId)
    const game: DatedGame = {
      id: crypto.randomUUID(),
      gameDate,
      name: gameName.trim() || `${homeTeam?.name ?? 'ホーム'} vs ${awayTeam?.name ?? 'アウェイ'}`,
      homeTeamId,
      awayTeamId,
      homeUniform,
      awayUniform,
      status: 'scheduled',
      currentQuarter: 1,
      events: [],
      createdAt: now,
      updatedAt: now,
    }

    try {
      await saveGame(game)
      await refreshData()
      setGameName('')
      setGameDate(todayLocal())
      setMessage('試合を作成して保存しました。')
    } catch (error) {
      console.error(error)
      setMessage('試合を保存できませんでした。')
    } finally {
      setSaving(false)
    }
  }

  async function handleGameStatusChange(game: Game, status: Game['status']) {
    try {
      await updateGame(game.id, current => ({ ...current, status, updatedAt: new Date().toISOString() }))
      await refreshData()
      setMessage('試合状況を保存しました。')
    } catch (error) {
      console.error(error)
      setMessage('試合状況を保存できませんでした。')
    }
  }

  async function handleDeleteGame(game: Game) {
    if (!window.confirm(`「${game.name}」をゴミ箱に移動しますか？あとから復元できます。`)) {
      return
    }
    try {
      await deleteGame(game.id)
      await refreshData()
      if (selectedGameId === game.id) {
        setSelectedGameId(null)
        setPage('games')
      }
      setMessage('試合をゴミ箱に移動しました。')
    } catch (error) {
      console.error(error)
      setMessage('試合を削除できませんでした。')
    }
  }

  // お気に入りのチームを試合作成の選択肢の先頭に表示する
  const favoriteTeamIdSet = new Set(favoriteTeamIds)
  const teamsForSelection = [...teams].sort((a, b) =>
    Number(favoriteTeamIdSet.has(b.id)) - Number(favoriteTeamIdSet.has(a.id)),
  )

  function teamLabel(teamId: string) {
    return teams.find((team) => team.id === teamId)?.name ?? '削除されたチーム'
  }

  function openGame(game: Game) {
    setSelectedGameId(game.id)
    setLineupSetupQuarter(game.currentQuarter || 1)
    const storedLineups = (game as Game & { quarterLineups?: Record<number, { home: string[]; away: string[] }> }).quarterLineups
    setHomeLineup(storedLineups?.[game.currentQuarter]?.home ?? game.homeLineup ?? [])
    setAwayLineup(storedLineups?.[game.currentQuarter]?.away ?? game.awayLineup ?? [])
    // 終了済みの試合は先発設定を経由せず、結果画面を開く
    setPage(game.status === 'completed' ? 'game-record' : 'game-detail')
    setMessage('')
  }


  async function handleFinishGame() {
    const game = games.find((item) => item.id === selectedGameId)
    if (!game) {
      setMessage('試合が見つかりません。')
      return
    }
    if (game.status === 'completed') {
      setMessage('この試合はすでに終了しています。')
      return
    }
    const homeScore = game.events.filter((event) => !event.cancelled && event.teamId === game.homeTeamId && (event.type === 'shot' || event.type === 'freeThrow') && event.made).reduce((sum, event) => sum + (event.points ?? (event.type === 'freeThrow' ? 1 : 0)), 0)
    const awayScore = game.events.filter((event) => !event.cancelled && event.teamId === game.awayTeamId && (event.type === 'shot' || event.type === 'freeThrow') && event.made).reduce((sum, event) => sum + (event.points ?? (event.type === 'freeThrow' ? 1 : 0)), 0)
    if (!window.confirm(`試合を終了しますか？\n\n${teamLabel(game.homeTeamId)}  ${homeScore} - ${awayScore}  ${teamLabel(game.awayTeamId)}\n\n終了後も結果の確認はできますが、試合記録は追加できなくなります。`)) return

    setSaving(true)
    setMessage('')
    try {
      await updateGame(game.id, current => ({ ...current, status: 'completed', updatedAt: new Date().toISOString() }))
      await refreshData()
      setMessage('試合を終了し、最終結果を保存しました。')
    } catch (error) {
      console.error(error)
      setMessage('試合終了を保存できませんでした。')
    } finally {
      setSaving(false)
    }
  }

  function toggleLineup(
    playerId: string,
    side: 'home' | 'away',
  ) {
    const lineup = side === 'home' ? homeLineup : awayLineup
    const setLineup = side === 'home' ? setHomeLineup : setAwayLineup

    if (lineup.includes(playerId)) {
      setLineup(lineup.filter((id) => id !== playerId))
      return
    }
    if (lineup.length >= 5) {
      setMessage('先発メンバーは各チーム5人まで選択できます。')
      return
    }
    setLineup([...lineup, playerId])
    setMessage('')
  }

  async function handleSaveLineups() {
    const game = games.find((item) => item.id === selectedGameId)
    if (!game) {
      setMessage('試合が見つかりません。試合一覧に戻ってください。')
      return
    }
    if (homeLineup.length !== 5 || awayLineup.length !== 5) {
      setMessage('ホーム・アウェイそれぞれ5人ずつ選択してください。')
      return
    }

    setSaving(true)
    setMessage('')
    try {
      await updateGame(game.id, current => {
        const existing = (current as Game & { quarterLineups?: Record<number, { home: string[]; away: string[] }> }).quarterLineups ?? {}
        return {
          ...current,
          homeLineup: lineupSetupQuarter === 1 ? [...homeLineup] : (current.homeLineup ?? [...homeLineup]),
          awayLineup: lineupSetupQuarter === 1 ? [...awayLineup] : (current.awayLineup ?? [...awayLineup]),
          quarterLineups: { ...existing, [lineupSetupQuarter]: { home: [...homeLineup], away: [...awayLineup] } },
          currentQuarter: lineupSetupQuarter,
          updatedAt: new Date().toISOString(),
        } as Game
      })
      await refreshData()
      setMessage(`${quarterLabel(lineupSetupQuarter)}の出場メンバーを保存しました。`)
      setPage('game-record')
      setSelectedPlayerId(homeLineup[0] ?? '')
    } catch (error) {
      console.error(error)
      setMessage('先発メンバーを保存できませんでした。')
    } finally {
      setSaving(false)
    }
  }

  async function handleRecordEvent(
    teamId: string,
    playerId: string,
    type: Game['events'][number]['type'],
    points?: number,
    made?: boolean,
  ) {
    const game = games.find((item) => item.id === selectedGameId)
    if (!game) {
      setMessage('試合が見つかりません。')
      return
    }
    const event = {
      id: crypto.randomUUID(),
      type,
      teamId,
      playerId,
      points,
      made: type === 'shot' || type === 'freeThrow' ? (made ?? true) : undefined,
      quarter: game.currentQuarter,
      createdAt: new Date().toISOString(),
    }
    try {
      await updateGame(game.id, current => ({ ...current, status: 'in-progress', events: [...current.events, event], updatedAt: new Date().toISOString() }))
      await refreshData()
      setMessage('記録を保存しました。')
    } catch (error) {
      console.error(error)
      setMessage('記録を保存できませんでした。')
    }
  }

  async function handleSaveFreeThrows() {
    const game = games.find((item) => item.id === selectedGameId)
    const player = [...(homeTeam?.players ?? []), ...(awayTeam?.players ?? [])].find((item) => item.id === selectedPlayerId)
    const team = homeTeam?.players.some((item) => item.id === selectedPlayerId) ? homeTeam : awayTeam
    if (!game || !player || !team) {
      setMessage('フリースローを記録する選手を選択してください。')
      return
    }
    const results = freeThrowResults.slice(0, freeThrowCount)
    if (results.some((result) => result === null)) {
      setMessage('各フリースローの成功・失敗を選択してください。')
      return
    }
    const createdAt = new Date().toISOString()
    const madeCount = results.filter(Boolean).length
    // フリースローは1回の獲得につき1イベントで保存し、試投数・成功数をまとめて保持する。
    const newEvent = {
      id: crypto.randomUUID(),
      type: 'freeThrow' as const,
      teamId: team.id,
      playerId: player.id,
      points: madeCount,
      made: madeCount > 0,
      freeThrowAttempts: freeThrowCount,
      quarter: game.currentQuarter,
      createdAt,
    } as Game['events'][number] & { freeThrowAttempts: number }
    setSaving(true)
    try {
      await updateGame(game.id, current => ({
        ...current,
        status: 'in-progress',
        events: [...current.events, newEvent],
        updatedAt: new Date().toISOString(),
      }))
      await refreshData()
      setFreeThrowModalOpen(false)
      setFreeThrowResults(Array(freeThrowCount).fill(null))
      setMessage(`フリースロー（${freeThrowCount}本中${madeCount}本成功）を1件保存しました。`)
    } catch (error) {
      console.error(error)
      setMessage('フリースローを保存できませんでした。')
    } finally {
      setSaving(false)
    }
  }

  function quarterLabel(quarter: number) {
    if (quarter >= 1 && quarter <= 4) return `${quarter}Q`
    if (quarter === 5) return 'OT'
    if (quarter === 6) return '2OT'
    return `${quarter}Q`
  }

  async function handleTimeout(teamId: string) {
    const game = games.find((item) => item.id === selectedGameId)
    if (!game) return
    const used = game.events.filter(event => !event.cancelled && event.type === 'timeout' && event.teamId === teamId && event.quarter === game.currentQuarter).length
    if (used >= timeoutLimit) {
      setMessage(`${quarterLabel(game.currentQuarter)}のタイムアウト上限（${timeoutLimit}回）に達しています。設定から上限を変更できます。`)
      return
    }
    const event = { id: crypto.randomUUID(), type: 'timeout' as const, teamId, quarter: game.currentQuarter, createdAt: new Date().toISOString() }
    try {
      await updateGame(game.id, current => {
        const usedNow = current.events.filter(e => !e.cancelled && e.type === 'timeout' && e.teamId === teamId && e.quarter === current.currentQuarter).length
        if (usedNow >= timeoutLimit) throw new Error('タイムアウト上限に達しました。')
        return { ...current, status: 'in-progress', events: [...current.events, { ...event, quarter: current.currentQuarter }], updatedAt: new Date().toISOString() }
      })
      await refreshData()
      setMessage(`${quarterLabel(game.currentQuarter)}のタイムアウトを記録しました。`)
    } catch (error) {
      console.error(error)
      setMessage('タイムアウトを保存できませんでした。')
    }
  }

  async function handleQuarterChange(quarter: number) {
    const game = games.find((item) => item.id === selectedGameId)
    if (!game) return
    if (quarter < 1 || quarter > 6) return
    setLineupSetupQuarter(quarter)
    setHomeLineup([])
    setAwayLineup([])
    setMessage(`${quarterLabel(quarter)}の先発メンバーを選択してください。`)
    setPage('game-detail')
  }

  function openSubstitution(teamId: string, currentLineup: string[]) {
    setSubstitutionTeamId(teamId)
    setSubstitutionLineup([...currentLineup])
    setMessage('')
  }

  function toggleSubstitutionPlayer(playerId: string) {
    setSubstitutionLineup(current => {
      if (current.includes(playerId)) return current.filter(id => id !== playerId)
      if (current.length >= 5) return current
      return [...current, playerId]
    })
  }

  async function handleSaveSubstitution() {
    const game = games.find(item => item.id === selectedGameId)
    const team = teams.find(item => item.id === substitutionTeamId)
    if (!game || !team || game.status === 'completed') return
    if (substitutionLineup.length !== 5 || new Set(substitutionLineup).size !== 5 ||
        substitutionLineup.some(id => !team.players.some(player => player.id === id))) {
      setMessage('出場する選手を5人選択してください。')
      return
    }
    const side = team.id === game.homeTeamId ? 'home' : team.id === game.awayTeamId ? 'away' : null
    if (!side) return
    setSaving(true)
    setMessage('')
    try {
      await updateGame(game.id, current => {
        if (current.status === 'completed') throw new Error('終了した試合は変更できません。')
        const lineups = (current as Game & { quarterLineups?: Record<number, { home: string[]; away: string[] }> }).quarterLineups ?? {}
        const currentQuarter = current.currentQuarter
        const existing = lineups[currentQuarter]?.[side] ?? (side === 'home' ? current.homeLineup ?? [] : current.awayLineup ?? [])
        const outgoing = existing.filter(id => !substitutionLineup.includes(id))
        const incoming = substitutionLineup.filter(id => !existing.includes(id))
        if (existing.length !== 5 || outgoing.length !== incoming.length) throw new Error('現在の出場選手が変更されています。')
        const createdAt = new Date().toISOString()
        const events = incoming.map((playerId, index) => ({
          id: crypto.randomUUID(), type: 'substitution' as const, teamId: team.id,
          playerId, relatedPlayerId: outgoing[index], quarter: currentQuarter, createdAt,
        }))
        return {
          ...current,
          quarterLineups: {
            ...lineups,
            [currentQuarter]: {
              ...(lineups[currentQuarter] ?? { home: current.homeLineup ?? [], away: current.awayLineup ?? [] }),
              [side]: [...substitutionLineup],
            },
          },
          events: [...current.events, ...events],
          status: events.length ? 'in-progress' : current.status,
          updatedAt: createdAt,
        } as Game
      })
      await refreshData()
      setSubstitutionTeamId(null)
      setMessage(`${team.name}の出場メンバーを登録しました。`)
    } catch (error) {
      console.error(error)
      setMessage('交代を保存できませんでした。試合の状態を確認してください。')
    } finally {
      setSaving(false)
    }
  }

  async function handleUndoLastEvent() {
    const game = games.find((item) => item.id === selectedGameId)
    if (!game) return
    const lastEvent = [...game.events].reverse().find((event) => !event.cancelled)
    if (!lastEvent) {
      setMessage('取り消せる記録がありません。')
      return
    }
    try {
      await updateGame(game.id, current => {
        const latest = [...current.events].reverse().find(e => !e.cancelled)
        return { ...current, events: current.events.map(e => e.id === latest?.id ? { ...e, cancelled: true } : e), updatedAt: new Date().toISOString() }
      })
      await refreshData()
      setMessage('直前の記録を取り消しました。')
    } catch (error) {
      console.error(error)
      setMessage('記録を取り消せませんでした。')
    }
  }

  async function handleDeleteEvent(eventId: string) {
    const game = games.find((item) => item.id === selectedGameId)
    if (!game || game.status === 'completed') return
    const target = game.events.find(event => event.id === eventId && !event.cancelled)
    if (!target) return
    if (!window.confirm('この記録を削除しますか？得点・スタッツも再計算されます。')) return
    try {
      await updateGame(game.id, current => ({ ...current, events: current.events.map(event => event.id === eventId ? { ...event, cancelled: true } : event), updatedAt: new Date().toISOString() }))
      await refreshData()
      setMessage('選択した記録を削除しました。')
    } catch (error) {
      console.error(error)
      setMessage('記録を削除できませんでした。')
    }
  }

  async function loadRecoveryData() {
    const [items, snapshots] = await Promise.all([getTrash(), getRestoreSnapshots()])
    setTrash(items)
    setRestoreSnapshots(snapshots)
  }

  async function handleRestoreTrash(item: TrashItem) {
    if (!window.confirm(`「${item.name}」をゴミ箱から復元しますか？`)) return
    try {
      setSaving(true)
      await restoreTrashItem(item.id)
      await refreshData()
      await loadRecoveryData()
      setMessage(`「${item.name}」を復元しました。`)
    } catch (error) {
      console.error(error)
      setMessage(error instanceof Error ? error.message : '復元できませんでした。')
    } finally { setSaving(false) }
  }

  async function handlePermanentDelete(item: TrashItem) {
    if (!window.confirm(`「${item.name}」を完全に削除しますか？この操作は取り消せません。`)) return
    try {
      setSaving(true)
      await permanentlyDeleteTrashItem(item.id)
      await loadRecoveryData()
      setMessage(`「${item.name}」を完全に削除しました。`)
    } catch (error) {
      console.error(error)
      setMessage('完全削除できませんでした。')
    } finally { setSaving(false) }
  }

  async function handleRestoreSnapshot(snapshot: RestoreSnapshot) {
    if (!window.confirm(`${new Date(snapshot.createdAt).toLocaleString('ja-JP')} の復元前データに戻しますか？\n現在のデータも自動退避されます。`)) return
    try {
      setSaving(true)
      await replaceAllData(snapshot.teams, snapshot.games)
      await refreshData()
      await loadRecoveryData()
      setSelectedGameId(null)
      setMessage('復元前のデータに戻しました。')
    } catch (error) {
      console.error(error)
      setMessage('復元前データを読み込めませんでした。')
    } finally { setSaving(false) }
  }

  async function handleExportBackup() {
    try {
      const [savedTeams, savedGames] = await Promise.all([getTeams(), getGames()])
      const backup = {
        format: 'TEAM_LINK_BACKUP',
        version: 1,
        exportedAt: new Date().toISOString(),
        teams: savedTeams,
        games: savedGames,
        settings: { timeoutLimit },
      }
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `team-link-backup-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setMessage(`バックアップを作成しました（チーム${savedTeams.length}件・試合${savedGames.length}件）。ファイルを安全な場所に保管してください。`)
    } catch (error) {
      console.error(error)
      setMessage('バックアップを作成できませんでした。')
    }
  }

  // 1試合単位の持ち運び用バックアップ。既存の全件バックアップとは別形式。
  async function handleExportSingleGame(gameId: string) {
    try {
      const [savedTeams, savedGames] = await Promise.all([getTeams(), getGames()])
      const game = savedGames.find((item) => item.id === gameId)
      if (!game) throw new Error('試合が見つかりません')
      const relatedTeams = savedTeams.filter((team) => team.id === game.homeTeamId || team.id === game.awayTeamId)
      if (relatedTeams.length !== 2) throw new Error('対戦チームの情報が不足しています')
      const datePart = ((game as DatedGame).gameDate || game.createdAt.slice(0, 10)).replace(/\//g, '-')
      const matchup = `${relatedTeams.find(t => t.id === game.homeTeamId)?.name ?? 'ホーム'}_VS_${relatedTeams.find(t => t.id === game.awayTeamId)?.name ?? 'アウェイ'}`
      const safeName = `${datePart}_${matchup}_試合バックアップ`.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      const payload = {
        format: 'TEAM_LINK_SINGLE_GAME',
        version: 1,
        exportedAt: new Date().toISOString(),
        teams: relatedTeams,
        game,
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${safeName}.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setMessage(`「${game.name}」の試合バックアップを保存しました。`)
    } catch (error) {
      console.error(error)
      setMessage(error instanceof Error ? error.message : '試合バックアップを作成できませんでした。')
    }
  }

  // 1試合だけを追加。既存の試合は上書きせず、チームと選手の参照関係を保つ。
  async function handleImportSingleGame(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('ファイルが大きすぎます（上限20MB）。')
      const parsed: unknown = JSON.parse(await file.text())
      if (!parsed || typeof parsed !== 'object') throw new Error('JSONファイルを確認してください。')
      const data = parsed as { format?: unknown; version?: unknown; teams?: unknown; game?: unknown }
      if (data.format !== 'TEAM_LINK_SINGLE_GAME' || data.version !== 1 || !Array.isArray(data.teams) || data.teams.length !== 2 || !data.game || typeof data.game !== 'object') {
        throw new Error('「この試合を保存」で作成したJSONファイルを選んでください。')
      }
      const incomingTeams = data.teams as Team[]
      const incomingGame = data.game as Game
      const validTeam = (team: Team) => team && typeof team.id === 'string' && !!team.id && typeof team.name === 'string' && Array.isArray(team.players) && team.players.every(player => player && typeof player.id === 'string' && typeof player.number === 'string' && typeof player.name === 'string')
      if (!incomingTeams.every(validTeam) || incomingTeams[0].id === incomingTeams[1].id || typeof incomingGame.id !== 'string' || !incomingGame.id || typeof incomingGame.name !== 'string' || !Array.isArray(incomingGame.events) || typeof incomingGame.homeTeamId !== 'string' || typeof incomingGame.awayTeamId !== 'string' || incomingGame.homeTeamId === incomingGame.awayTeamId || !incomingTeams.some(team => team.id === incomingGame.homeTeamId) || !incomingTeams.some(team => team.id === incomingGame.awayTeamId) || !incomingGame.events.every(item => item && typeof item.id === 'string' && typeof item.teamId === 'string' && typeof item.type === 'string' && typeof item.quarter === 'number' && [incomingGame.homeTeamId, incomingGame.awayTeamId].includes(item.teamId))) {
        throw new Error('試合または選手データの形式が正しくありません。')
      }
      const [currentTeams, currentGames] = await Promise.all([getTeams(), getGames()])
      if (currentGames.some(game => game.id === incomingGame.id)) {
        throw new Error('同じ試合IDがすでに保存されています。重複取り込みを防ぐため追加しませんでした。')
      }
      // チームIDが違っても同名なら既存チームへ統合する（前後の空白・全半角・大文字小文字を正規化）。
      // 同名チームが複数ある場合は誤統合を避け、ユーザーに整理を依頼する。
      const normalizeName = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ja-JP')
      const teamIdMap = new Map<string, string>()
      const playerIdMap = new Map<string, string>()
      const teamsToSave: Team[] = []
      let newTeamCount = 0
      let mergedTeamCount = 0
      let addedPlayerCount = 0
      for (const team of incomingTeams) {
        const byId = currentTeams.find(item => item.id === team.id)
        const sameNames = currentTeams.filter(item => normalizeName(item.name) === normalizeName(team.name))
        if (sameNames.length > 1 && !byId) {
          throw new Error(`「${team.name}」と同名のチームが複数あります。取り込み前にチーム管理で整理してください。`)
        }
        // 同じIDで名前が違う場合はID衝突。既存のチームを上書きしない。
        const existing = byId?.name === team.name ? byId : (sameNames.length === 1 ? sameNames[0] : undefined)
        if (!existing) {
          const newId = byId || currentTeams.some(item => item.id === team.id) || teamsToSave.some(item => item.id === team.id)
            ? crypto.randomUUID() : team.id
          teamIdMap.set(team.id, newId)
          teamsToSave.push({ ...team, id: newId })
          newTeamCount++
          continue
        }
        teamIdMap.set(team.id, existing.id)
        mergedTeamCount++
        const mergedPlayers = [...existing.players]
        for (const player of team.players) {
          const byPlayerId = mergedPlayers.find(item => item.id === player.id)
          // 端末間で選手IDが違う場合も、背番号と名前が一致すれば同じ選手として扱う。
          const byIdentity = mergedPlayers.find(item => String(item.number) === String(player.number) && normalizeName(item.name) === normalizeName(player.name))
          const matched = byIdentity ?? (byPlayerId && byPlayerId.name === player.name && byPlayerId.number === player.number ? byPlayerId : undefined)
          if (matched) {
            playerIdMap.set(`${team.id}:${player.id}`, matched.id)
            continue
          }
          // 既存選手とIDだけが衝突する場合は新IDを付与。既存選手は変更しない。
          const newPlayerId = byPlayerId ? crypto.randomUUID() : player.id
          playerIdMap.set(`${team.id}:${player.id}`, newPlayerId)
          mergedPlayers.push({ ...player, id: newPlayerId })
          addedPlayerCount++
        }
        if (mergedPlayers.length !== existing.players.length) teamsToSave.push({ ...existing, players: mergedPlayers })
      }
      if (teamIdMap.get(incomingGame.homeTeamId) === teamIdMap.get(incomingGame.awayTeamId)) {
        throw new Error('対戦する2チームが同じチームに統合されてしまいます。チーム名を確認してください。')
      }
      const remapPlayer = (teamId: string, playerId: string) => playerIdMap.get(`${teamId}:${playerId}`) ?? playerId
      const remapLineup = (teamId: string, lineup?: string[]) => lineup?.map(id => remapPlayer(teamId, id))
      const quarterLineups = (incomingGame as Game & { quarterLineups?: Record<number, { home: string[]; away: string[] }> }).quarterLineups
      const remappedQuarters = quarterLineups ? Object.fromEntries(Object.entries(quarterLineups).map(([quarter, lineup]) => [quarter, {
        home: remapLineup(incomingGame.homeTeamId, lineup.home) ?? [],
        away: remapLineup(incomingGame.awayTeamId, lineup.away) ?? [],
      }])) : undefined
      const remappedGame = {
        ...incomingGame,
        homeTeamId: teamIdMap.get(incomingGame.homeTeamId)!,
        awayTeamId: teamIdMap.get(incomingGame.awayTeamId)!,
        homeLineup: remapLineup(incomingGame.homeTeamId, incomingGame.homeLineup),
        awayLineup: remapLineup(incomingGame.awayTeamId, incomingGame.awayLineup),
        ...(remappedQuarters ? { quarterLineups: remappedQuarters } : {}),
        events: incomingGame.events.map(item => ({
          ...item,
          teamId: teamIdMap.get(item.teamId) ?? item.teamId,
          ...(item.playerId ? { playerId: remapPlayer(item.teamId, item.playerId) } : {}),
          ...(item.relatedPlayerId ? { relatedPlayerId: remapPlayer(item.teamId, item.relatedPlayerId) } : {}),
        })),
      }
      if (!window.confirm(`次の試合をこの端末へ追加しますか？\n\n${incomingGame.name}\n試合ID：${incomingGame.id}\n\n既存の試合データは削除・上書きしません。新規チーム：${newTeamCount}件\n既存チームへ統合：${mergedTeamCount}件\n追加選手：${addedPlayerCount}人\n\n必要な情報だけ追加し、既存チーム・試合は削除しません。`)) return
      setSaving(true)
      for (const team of teamsToSave) await saveTeam(team)
      await saveGame(remappedGame)
      await refreshData()
      setMessage(`「${incomingGame.name}」を1試合追加しました。新規チーム${newTeamCount}件・追加選手${addedPlayerCount}人。既存の試合はそのままです。`)
    } catch (error) {
      console.error(error)
      setMessage(error instanceof Error ? error.message : '試合データを取り込めませんでした。')
    } finally {
      setSaving(false)
    }
  }

  async function handleImportBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!parsed || typeof parsed !== 'object') throw new Error('invalid backup')
      const data = parsed as { format?: unknown; version?: unknown; teams?: unknown; games?: unknown; settings?: { timeoutLimit?: unknown } }
      const validTeams = Array.isArray(data.teams) && data.teams.every((team: any) => team && typeof team.id === 'string' && typeof team.name === 'string' && Array.isArray(team.players))
      const validGames = Array.isArray(data.games) && data.games.every((game: any) => game && typeof game.id === 'string' && typeof game.name === 'string' && Array.isArray(game.events))
      if (data.format !== 'TEAM_LINK_BACKUP' || data.version !== 1 || !validTeams || !validGames) {
        throw new Error('invalid backup format')
      }
      const incomingTeams = data.teams as Team[]
      const incomingGames = data.games as Game[]
      if (!window.confirm(`バックアップを復元しますか？\n\nチーム：${incomingTeams.length}件\n試合：${incomingGames.length}件\n\n現在この端末に保存されているチーム・試合データはすべて置き換わります。復元前のデータは自動で端末内に退避されます。`)) return
      setSaving(true)
      await replaceAllData(incomingTeams, incomingGames)
      await loadRecoveryData()
      const savedLimit = Number(data.settings?.timeoutLimit)
      if ([1, 2, 3].includes(savedLimit)) {
        setTimeoutLimit(savedLimit)
        localStorage.setItem('team-link-timeout-limit', String(savedLimit))
      }
      await refreshData()
      setSelectedGameId(null)
      setPage('teams')
      setMessage(`バックアップを復元しました（チーム${incomingTeams.length}件・試合${incomingGames.length}件）。`)
    } catch (error) {
      console.error(error)
      setMessage('復元できませんでした。TEAM LINKで作成した正しいバックアップファイルか確認してください。')
    } finally {
      setSaving(false)
    }
  }

  function renderBoxScore(game: Game, homeTeam: Team, awayTeam: Team) {
    return (
                <section className="mt-2 rounded-lg border border-slate-200 bg-white p-2">
                  <div className="mb-1">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-bold">ボックススコア</h3>
                        <p className="text-xs text-slate-500">記録に応じて自動更新</p>
                      </div>
                    </div>
                  </div>
                  {[{ team: homeTeam, lineup: game.homeLineup ?? [] }, { team: awayTeam, lineup: game.awayLineup ?? [] }].map(({ team }) => (
                    <div key={team.id} className="mb-2 last:mb-0">
                      <h4 className="mb-1 text-sm font-bold">{team.name}</h4>
                      <div className="w-full overflow-hidden">
                        <table className="w-full table-fixed border-collapse text-[clamp(7px,0.8vw,13px)]"><colgroup><col style={{width:'16%'}} />{Array.from({length:14}, (_, i) => <col key={i} style={{width:'6%'}} />)}</colgroup>
                          <thead>
                            <tr className="bg-slate-100 text-left">
                              {['選手', '得点', 'FG', 'FG%', '3FG', '3FG%', 'FT', 'FT%', 'OREB', 'DREB', 'STL', 'BLK', 'AST', 'TO', 'PF'].map(label => <th key={label} className="break-words border-b border-slate-200 px-0.5 py-1 font-semibold">{label}</th>)}
                            </tr>
                          </thead>
                          <tbody>
                            {team.players.filter(player => {
                              const initialLineup = team.id === game.homeTeamId ? (game.homeLineup ?? []) : (game.awayLineup ?? [])
                              const hasPlayedEvent = game.events.some(event => !event.cancelled && event.teamId === team.id && (event.playerId === player.id || event.relatedPlayerId === player.id))
                              return initialLineup.includes(player.id) || hasPlayedEvent
                            }).map(player => {
                              const playerEvents = game.events.filter(event => !event.cancelled && event.teamId === team.id && event.playerId === player.id)
                              const count = (type: string) => playerEvents.filter(event => event.type === type).length
                              const points = playerEvents.filter(event => (event.type === 'shot' || event.type === 'freeThrow') && event.made).reduce((sum, event) => sum + (event.points ?? (event.type === 'freeThrow' ? 1 : 0)), 0)
                              const shots = playerEvents.filter(event => event.type === 'shot')
                              const madeShots = shots.filter(event => event.made).length
                              const threes = shots.filter(event => event.points === 3)
                              const madeThrees = threes.filter(event => event.made).length
                              const freeThrows = playerEvents.filter(event => event.type === 'freeThrow')
                              const ftMade = freeThrows.reduce((sum, event) => sum + (event.points ?? (event.made ? 1 : 0)), 0)
                              const ftAttempts = freeThrows.reduce((sum, event) => sum + ((event as typeof event & { freeThrowAttempts?: number }).freeThrowAttempts ?? 1), 0)
                              const pct = (made: number, attempts: number) => attempts ? `${Math.round(made / attempts * 100)}%` : '0%'
                              const values: (string | number)[] = [points, `${madeShots}/${shots.length}`, pct(madeShots, shots.length), `${madeThrees}/${threes.length}`, pct(madeThrees, threes.length), `${ftMade}/${ftAttempts}`, pct(ftMade, ftAttempts), count('offensiveRebound'), count('defensiveRebound'), count('steal'), count('block'), count('assist'), count('turnover'), count('foul')]
                              return (
                                <tr key={player.id} className="border-b border-slate-100 last:border-0">
                                  <td className="break-words px-0.5 py-1 font-semibold">#{player.number} {player.name}</td>
                                  {values.map((value, index) => <td key={index} className={`break-words px-0.5 py-1 tabular-nums ${index === 0 ? 'font-bold text-blue-700' : ''}`}>{value}</td>)}
                                </tr>
                              )
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="bg-slate-50 font-bold">
                              <td className="px-0.5 py-1">チーム合計</td>
                              {(() => {
                                const ev = game.events.filter(event => !event.cancelled && event.teamId === team.id)
                                const shots = ev.filter(event => event.type === 'shot')
                                const made = shots.filter(event => event.made).length
                                const threes = shots.filter(event => event.points === 3)
                                const madeThrees = threes.filter(event => event.made).length
                                const freeThrows = ev.filter(event => event.type === 'freeThrow')
                                const ftMade = freeThrows.reduce((sum, event) => sum + (event.points ?? (event.made ? 1 : 0)), 0)
                                const ftAttempts = freeThrows.reduce((sum, event) => sum + ((event as typeof event & { freeThrowAttempts?: number }).freeThrowAttempts ?? 1), 0)
                                const points = ev.filter(event => (event.type === 'shot' || event.type === 'freeThrow') && event.made).reduce((sum, event) => sum + (event.points ?? (event.type === 'freeThrow' ? 1 : 0)), 0)
                                const pct = (m: number, a: number) => a ? `${Math.round(m / a * 100)}%` : '0%'
                                const totals: (string | number)[] = [points, `${made}/${shots.length}`, pct(made, shots.length), `${madeThrees}/${threes.length}`, pct(madeThrees, threes.length), `${ftMade}/${ftAttempts}`, pct(ftMade, ftAttempts), ...['offensiveRebound','defensiveRebound','steal','block','assist','turnover','foul'].map(type => ev.filter(event => event.type === type).length)]
                                return totals.map((value, index) => <td key={index} className="break-words px-0.5 py-1 tabular-nums">{value}</td>)
                              })()}
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  ))}
                </section>
    )
  }

  // スコア表示をブラウザで実際に描画した画像としてPDFに埋め込む。
  // 旧方式（DOMの背景色・罫線・文字をpdf-libで再描画）はCSSを再現できず、
  // 黒塗りや罫線消失を起こしたため使用しない。
  async function shareScoreSheetPdf(game: Game, prepareOnly = false) {
    // 準備済みPDFがあれば、共有ボタンは即座に共有シートを開く。
    if (!prepareOnly && preparedPdf?.gameId === game.id) {
      await sharePdfFile(preparedPdf.file)
      return
    }
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('[data-teamlink-score-sheet]'))
    const source = candidates.find(el => el.dataset.gameId === game.id && el.closest('[role="dialog"]'))
      ?? candidates.find(el => el.dataset.gameId === game.id && el.getBoundingClientRect().width > 0)
    if (!source) { setMessage('スコア表示を開いてからPDF共有してください。'); return }
    setPdfPreparing(true)
    setMessage(prepareOnly ? 'PDFを準備しています...' : 'PDFを生成しています...')
    let staging: HTMLDivElement | null = null
    try {
      const [{ PDFDocument }, { default: html2canvas }] = await Promise.all([
        import('pdf-lib'),
        import('html2canvas-pro'),
      ])
      // 画面幅・拡大率・親要素のtransform/overflowに左右されないよう、
      // 印刷用のスコアシートを固定サイズでDOMに独立配置する。
      const captureWidth = 1800
      const captureHeight = 900
      staging = document.createElement('div')
      staging.setAttribute('aria-hidden', 'true')
      Object.assign(staging.style, {
        position: 'fixed', left: '0px', top: '0px', zIndex: '-2147483647',
        width: `${captureWidth}px`, height: `${captureHeight}px`,
        overflow: 'hidden', pointerEvents: 'none', background: '#ffffff',
        opacity: '1', transform: 'none',
      })
      const clone = source.cloneNode(true) as HTMLElement
      clone.classList.remove('fixed', 'inset-0', 'z-50', 'h-[100dvh]', 'w-screen')
      clone.querySelectorAll('button').forEach(button => button.remove())
      clone.style.setProperty('position', 'relative', 'important')
      clone.style.setProperty('inset', 'auto', 'important')
      clone.style.setProperty('width', `${captureWidth}px`, 'important')
      clone.style.setProperty('min-width', `${captureWidth}px`, 'important')
      clone.style.setProperty('max-width', 'none', 'important')
      clone.style.setProperty('height', `${captureHeight}px`, 'important')
      clone.style.setProperty('min-height', `${captureHeight}px`, 'important')
      clone.style.setProperty('max-height', 'none', 'important')
      clone.style.setProperty('transform', 'none', 'important')
      clone.style.setProperty('overflow', 'hidden', 'important')
      clone.style.setProperty('background', '#ffffff', 'important')
      // html2canvas-pro は rowspan=2 の見出しを上半分だけ描画することがある。
      // PDF用の複製だけ、2段ヘッダーを rowspan のない1段ヘッダーに変換する。
      // colgroup/列数/データ行は変更しないので表の横幅と集計は維持される。
      clone.querySelectorAll<HTMLTableElement>('table').forEach(table => {
        const thead = table.tHead
        if (!thead || thead.rows.length !== 2 || !thead.querySelector('th[rowspan="2"]')) return
        const firstRow = thead.rows[0]
        const secondRow = thead.rows[1]
        const attendanceNumbers = Array.from(secondRow.cells).map(cell => cell.textContent?.trim() ?? '')
        const firstCells = Array.from(firstRow.cells)
        const attendanceCell = firstCells.find(cell => cell.textContent?.includes('出場時間'))
        if (!attendanceCell) return
        attendanceCell.innerHTML = ''
        const heading = document.createElement('div')
        heading.textContent = '出場時間'
        heading.style.cssText = 'height:16px;line-height:16px;text-align:center;white-space:nowrap;'
        const quarters = document.createElement('div')
        quarters.style.cssText = 'display:flex;width:100%;height:16px;line-height:16px;align-items:center;'
        attendanceNumbers.forEach(number => {
          const part = document.createElement('span')
          part.textContent = number
          part.style.cssText = 'flex:1;min-width:0;text-align:center;border-right:1px solid #94a3b8;'
          quarters.appendChild(part)
        })
        attendanceCell.append(heading, quarters)
        firstCells.forEach(cell => {
          if (cell instanceof HTMLTableCellElement) {
            cell.removeAttribute('rowspan')
            cell.style.setProperty('height', '34px', 'important')
            cell.style.setProperty('min-height', '34px', 'important')
            cell.style.setProperty('line-height', '18px', 'important')
            cell.style.setProperty('vertical-align', 'middle', 'important')
            cell.style.setProperty('overflow', 'visible', 'important')
            cell.style.setProperty('white-space', 'nowrap', 'important')
            cell.style.setProperty('padding-top', '1px', 'important')
            cell.style.setProperty('padding-bottom', '1px', 'important')
          }
        })
        secondRow.remove()
        firstRow.style.setProperty('height', '34px', 'important')
        table.style.setProperty('border-collapse', 'collapse', 'important')
      })
      staging.appendChild(clone)
      document.body.appendChild(staging)
      await document.fonts.ready
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const canvas = await html2canvas(clone, {
        backgroundColor: '#ffffff',
        width: captureWidth,
        height: captureHeight,
        scale: 1.5,
        useCORS: true,
        logging: false,
        onclone: (doc: Document) => {
          // キャプチャ側のルート要素に画面幅制約を適用させない。
          doc.documentElement.style.width = `${captureWidth}px`
          doc.documentElement.style.minWidth = `${captureWidth}px`
        },
      })
      const pngBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        canvas.toBlob((blob: Blob | null) => {
          if (!blob) { reject(new Error('スコア表示の画像生成に失敗しました。')); return }
          blob.arrayBuffer().then(resolve, reject)
        }, 'image/png')
      })
      const pdf = await PDFDocument.create()
      // スコア表示の横長比率を維持した1ページPDF（印刷時は用紙に合わせて縮小可能）。
      const page = pdf.addPage([captureWidth, captureHeight])
      const image = await pdf.embedPng(pngBytes)
      page.drawImage(image, { x: 0, y: 0, width: captureWidth, height: captureHeight })
      const bytes = await pdf.save()
      // ファイル名：試合日_ホームチーム名 VS アウェイチーム名_ボックススコア.pdf
      // ファイル名に使用できない文字（特に日付の / ）は置き換える。
      const safeFilePart = (value: string) => value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || '名称未設定'
      const datePart = formatGameDate((game as DatedGame).gameDate ?? game.createdAt).replace(/\//g, '-')
      const opponentPart = `${teamLabel(game.homeTeamId)} VS ${teamLabel(game.awayTeamId)}`
      const fileName = `${safeFilePart(datePart)}_${safeFilePart(opponentPart)}_ボックススコア.pdf`
      const file = new File([new Uint8Array(bytes)], fileName, { type: 'application/pdf' })
      setPreparedPdf({ gameId: game.id, file })
      if (prepareOnly) {
        setMessage('PDFを準備しました。「共有」または「PDF保存」を選んでください。')
      } else {
        await sharePdfFile(file)
      }
    } catch (error) {
      setMessage(`PDF生成に失敗しました：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      staging?.remove()
      setPdfPreparing(false)
    }
  }

  // ユーザーが「共有」を押したタイミングで直接共有シートを開く。
  async function sharePdfFile(file: File) {
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      try {
        await navigator.share({ files: [file], title: file.name })
        setMessage('共有操作が完了しました。LINEへの送信結果をご確認ください。')
      } catch (shareError) {
        if (shareError instanceof DOMException && shareError.name === 'AbortError') {
          setMessage('共有がキャンセルされました。')
        } else {
          savePdfFile(file)
          setMessage('共有シートを開けなかったためPDFを保存しました。LINEから添付してください。')
        }
      }
    } else {
      savePdfFile(file)
      setMessage('この端末ではPDFの直接共有に対応していないため、PDFを保存しました。LINEから添付してください。')
    }
  }

  // Web Share API非対応時のみPDFを端末に保存する。
  function savePdfFile(file: File) {
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }

  function renderOriginalSheet(game: Game, homeTeam: Team, awayTeam: Team, embedded = false) {

                  const activeEvents = game.events
                    .filter(event => !event.cancelled)
                    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
                  const scoringEvents = activeEvents.filter(event =>
                    (event.type === 'shot' || event.type === 'freeThrow') && event.made &&
                    (event.points ?? (event.type === 'freeThrow' ? 1 : 0)) > 0
                  )
                  const pointsOf = (event: typeof activeEvents[number]) => event.points ?? (event.type === 'freeThrow' ? 1 : 0)
                  const scoreFor = (teamId: string) => scoringEvents.filter(event => event.teamId === teamId).reduce((sum, event) => sum + pointsOf(event), 0)
                  const eventSymbol = (event: typeof activeEvents[number]) => {
                    if (event.type === 'shot' && !event.made) return pointsOf(event) === 3 ? '〇' : '/'
                    if (event.type === 'shot' && event.made) return pointsOf(event) === 3 ? '③' : '☓'
                    if (event.type === 'freeThrow') {
                      const attempts = (event as typeof event & { freeThrowAttempts?: number }).freeThrowAttempts ?? 1
                      const successes = event.made ? Math.max(0, Math.min(attempts, pointsOf(event))) : 0
                      if (attempts === 1) return successes === 1 ? '〼' : '☐'
                      if (attempts === 2) {
                        if (successes === 2) return '☒'
                        if (successes === 1) return '〼'
                        return '☐'
                      }
                      if (attempts === 3) {
                        if (successes === 3) return '☒〼'
                        if (successes === 2) return '☒'
                        if (successes === 1) return '〼☐'
                        return '☐☐'
                      }
                      return event.made ? '〼' : '☐'
                    }
                    if (event.type === 'timeout') return '〼'
                    return ''
                  }
                  const teamLineups = [
                    { team: homeTeam, lineup: game.homeLineup ?? [] },
                    { team: awayTeam, lineup: game.awayLineup ?? [] },
                  ]
                  const appeared = (team: Team, lineup: string[]) => team.players.filter(player =>
                    lineup.includes(player.id) || activeEvents.some(event => event.teamId === team.id && event.playerId === player.id)
                  )
                  const runningScorers = (team: Team) => {
                    let total = 0
                    const grid: Array<{ total: number; number: string } | null> = Array(100).fill(null)
                    scoringEvents.filter(event => event.teamId === team.id).forEach(event => {
                      total += pointsOf(event)
                      const player = team.players.find(item => item.id === event.playerId)
                      if (total >= 1 && total <= 100) grid[total - 1] = { total, number: player?.number ?? '?' }
                    })
                    return grid
                  }
                  return <section data-teamlink-score-sheet="true" data-game-id={game.id} className={embedded ? "relative flex h-[900px] min-w-[1000px] flex-col overflow-hidden bg-white p-1 !text-black [&_*]:!text-black sm:p-2" : "fixed inset-0 z-50 flex h-[100dvh] w-screen flex-col overflow-hidden bg-white p-1 !text-black [&_*]:!text-black sm:p-2"}>
                    <div className="mb-1 flex shrink-0 items-center justify-between gap-2 border-b border-slate-800 pb-1">
                      <div className="min-w-0 w-[50%] shrink-0 text-center">
                        <h3 className="truncate text-sm font-black">{game.name}</h3>
                        <div className="flex items-center justify-center gap-3 text-xs font-bold"><span>{homeTeam.name} <b className="text-lg">{scoreFor(homeTeam.id)}</b></span><span>VS</span><span><b className="text-lg">{scoreFor(awayTeam.id)}</b> {awayTeam.name}</span></div>
                      </div>
                      <div className="min-w-0 flex-1 overflow-hidden" aria-label="クォーター別スコア">
                        <table className="w-full table-fixed border-collapse text-[9px] leading-none tabular-nums">
                          <thead><tr className="bg-slate-100"><th className="w-[30%] whitespace-nowrap border border-slate-400 px-1 py-0.5">チーム</th>{visibleQuarters(game).map(q => <th key={q} className="whitespace-nowrap border border-slate-400 px-1 py-0.5">{quarterLabel(q)}</th>)}<th className="border border-slate-400 px-1 py-0.5">合計</th></tr></thead>
                          <tbody>{[homeTeam, awayTeam].map(team => {
                            const teamScoringEvents = scoringEvents.filter(event => event.teamId === team.id)
                            const byQuarter = (q: number) => teamScoringEvents.filter(event => event.quarter === q).reduce((sum, event) => sum + pointsOf(event), 0)
                            return <tr key={team.id}><th className="overflow-hidden text-ellipsis whitespace-nowrap border border-slate-400 px-1 py-0.5 text-left" title={team.name}>{team.name}</th>{visibleQuarters(game).map(q => <td key={q} className="border border-slate-400 px-1 py-0.5 text-center">{byQuarter(q)}</td>)}<td className="border border-slate-400 px-1 py-0.5 text-center font-black">{scoreFor(team.id)}</td></tr>
                          })}</tbody>
                        </table>
                      </div>
                      {!embedded && <button type="button" onClick={() => setRecordView('official')} className="shrink-0 rounded border border-slate-400 px-2 py-1 text-xs font-bold">記録画面へ戻る</button>}
                    </div>
                    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-2 gap-1 overflow-hidden">
                    {teamLineups.map(({team, lineup}) => {
                      const players = appeared(team, lineup)
                      const teamEvents = activeEvents.filter(event => event.teamId === team.id)
                      const quarterScore = (q: number) => teamEvents.filter(event => event.quarter === q && (event.type === 'shot' || event.type === 'freeThrow') && event.made).reduce((sum, event) => sum + pointsOf(event), 0)
                      const runners = runningScorers(team)
                      return <div key={team.id} className="flex min-h-0 min-w-0 flex-col overflow-hidden border-b border-slate-500">
                        <h4 className="shrink-0 border border-slate-700 bg-slate-200 px-1 py-0.5 text-xs font-black">{team.name}　合計 {scoreFor(team.id)} 点</h4>
                        <div className="min-h-0 flex-1 overflow-hidden">
                          <table className="w-full table-fixed border-collapse text-[10px] leading-tight">
                            <colgroup>
                              <col style={{ width: '4%' }} />
                              <col style={{ width: '8%' }} />
                              {visibleQuarters(game).map(q => <col key={`attendance-${q}`} style={{ width: `${8 / visibleQuarters(game).length}%` }} />)}
                              <col style={{ width: '8%' }} />
                              {visibleQuarters(game).map(q => <col key={`score-${q}`} style={{ width: `${60 / visibleQuarters(game).length}%` }} />)}
                              {[1, 2, 3].map(i => <col key={`summary-${i}`} style={{ width: '4%' }} />)}
                            </colgroup>
                            <thead>
                              <tr className="bg-slate-100">
                                <th rowSpan={2} className="border border-slate-500 px-0 py-0.5 text-center align-middle">No.</th>
                                <th rowSpan={2} className="border border-slate-500 px-0 py-0.5 text-left align-middle">選手名</th>
                                <th colSpan={visibleQuarters(game).length} className="border border-slate-500 px-0 py-0.5 text-center">出場時間</th>
                                <th rowSpan={2} className="border border-slate-500 px-0 py-0.5 text-center align-middle">ファウル</th>
                                {visibleQuarters(game).map(q => <th key={q} rowSpan={2} className="border border-slate-500 px-0 py-0.5 text-center align-middle">{quarterLabel(q)}</th>)}
                                <th rowSpan={2} className="border border-slate-500 px-0 py-0.5 text-center align-middle">前半</th><th rowSpan={2} className="border border-slate-500 px-0 py-0.5 text-center align-middle">後半</th><th rowSpan={2} className="border border-slate-500 px-0 py-0.5 text-center align-middle">合計</th>
                              </tr>
                              <tr className="bg-slate-100">{visibleQuarters(game).map(q => <th key={q} className="border border-slate-500 px-0 py-0.5 text-center">{q}</th>)}</tr>
                            </thead>
                            <tbody>{players.map(player => {
                              const pe = teamEvents.filter(event => event.playerId === player.id)
                              const foulSymbols = pe.filter(event => event.type === 'foul').map(event => `P${(['₁','₂','₃','₄'][Math.min(event.quarter, 4) - 1] ?? '₄')}`)
                              const qCells = visibleQuarters(game).map(q => pe.filter(event => event.quarter === q && event.type !== 'foul' && event.type !== 'offensiveRebound' && event.type !== 'defensiveRebound').map(eventSymbol).filter(Boolean))
                              const qPoints = [1,2,3,4,5,6].map(q => pe.filter(event => event.quarter === q && (event.type === 'shot' || event.type === 'freeThrow') && event.made).reduce((sum, event) => sum + pointsOf(event), 0))
                              const firstHalf = qPoints[0] + qPoints[1]
                              const secondHalf = qPoints[2] + qPoints[3] + qPoints[4] + qPoints[5]
                              return <tr key={player.id}>
                                <td className="border border-slate-400 px-0.5 py-[1px]">{player.number}</td><td className="truncate border border-slate-400 px-0.5 py-[1px] font-semibold">{player.name}</td>{visibleQuarters(game).map(q => { const storedLineups = (game as Game & { quarterLineups?: Record<number, { home: string[]; away: string[] }> }).quarterLineups ?? {}; const qLineup = storedLineups[q]?.[team.id === game.homeTeamId ? 'home' : 'away'] ?? (q === 1 ? lineup : []); const wasSubbedIn = teamEvents.some(e => e.type === 'substitution' && e.quarter === q && e.playerId === player.id); const wasSubbedOut = teamEvents.some(e => e.type === 'substitution' && e.quarter === q && e.relatedPlayerId === player.id); const appearedInQuarter = teamEvents.some(e => e.quarter === q && (e.playerId === player.id || e.relatedPlayerId === player.id)); const active = wasSubbedIn || wasSubbedOut || appearedInQuarter || qLineup.includes(player.id); return <td key={q} className="border border-slate-400 px-0 py-[1px] text-center font-bold leading-none"><span className={`inline-block ${wasSubbedIn ? 'text-red-600' : 'text-black'}`}>{active ? '〼' : '☐'}</span></td> })}<td className="border border-slate-400 px-0 py-[1px] text-center align-top"><div className="flex min-h-[16px] w-full">{[0,1,2,3,4].map(slot => <span key={slot} className={`flex min-w-0 flex-1 items-start justify-center font-bold text-red-700 ${slot < 4 ? 'border-r border-slate-400' : ''}`}>{foulSymbols[slot] ?? ''}</span>)}</div></td>
                                {qCells.map((symbols, i) => <td key={i} className="border border-slate-400 px-0 py-[1px] text-left align-top"><div className="flex min-h-[16px] flex-wrap content-start justify-start gap-0">{symbols.length ? symbols.map((symbol, j) => <span key={j} className={`inline-block ${(['/', '〇', '☐', '☐☐', '〼☐'].includes(symbol)) ? 'font-bold text-red-700' : ''}`}>{symbol}</span>) : <span className="text-slate-300">·</span>}</div></td>)}
                                <td className="border border-slate-400 px-0 py-[1px] text-center">{firstHalf || ''}</td><td className="border border-slate-400 px-0 py-[1px] text-center">{secondHalf || ''}</td><td className="border border-slate-400 px-0 py-[1px] text-center font-black">{qPoints.reduce((sum, n) => sum+n, 0)}</td>
                              </tr>
                            })}</tbody>
                            <tfoot><tr className="bg-slate-100 font-black"><td colSpan={3 + visibleQuarters(game).length} className="border border-slate-500 p-1">チーム合計</td>{visibleQuarters(game).map(q=><td key={q} className="border border-slate-500 p-1 text-left">{quarterScore(q)}</td>)}<td className="border border-slate-500 p-1 text-center">{quarterScore(1)+quarterScore(2)}</td><td className="border border-slate-500 p-1 text-center">{quarterScore(3)+quarterScore(4)+quarterScore(5)+quarterScore(6)}</td><td className="border border-slate-500 p-1 text-center">{scoreFor(team.id)}</td></tr></tfoot>
                          </table>
                        </div>
                        <div className="mt-1 shrink-0 grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,6fr)] gap-0.5 items-start">
                          <div className="min-w-0 self-start border border-slate-400 px-0.5 py-0.5">
                            <div className="mb-0.5 text-center text-[8px] font-bold">タイムアウト</div>
                            <div className="grid grid-cols-4 gap-x-0.5 text-center text-[8px] leading-tight">{[1,2,3,4].map(q => <div key={`to-label-${q}`} className="font-semibold">{q}Q</div>)}{[1,2,3,4].map(q => { const count = teamEvents.filter(e => e.quarter === q && e.type === 'timeout').length; return <div key={`to-${q}`} className="text-xs font-bold">{count ? '〼'.repeat(Math.min(timeoutLimit,count)) : '☐'}</div> })}</div>
                          </div>
                          <div className="min-w-0 self-start border border-slate-400 px-0.5 py-0.5">
                            <div className="mb-0.5 text-center text-[8px] font-bold">チームファウル</div>
                            <div className="grid grid-cols-4 gap-x-0.5 gap-y-1 text-center text-[8px] leading-tight">{[1,2,3,4].map(q => <div key={`f-label-${q}`} className="font-semibold">{q}Q</div>)}{[1,2,3,4].map(q => { const count = teamEvents.filter(e => e.quarter === q && e.type === 'foul').length; return <div key={`f-${q}`} className="whitespace-nowrap text-[10px] font-bold">{'☒'.repeat(Math.min(4,count))}{'☐'.repeat(Math.max(0,4-count))}</div> })}</div>
                          </div>
                          <div className="min-w-0 border border-slate-400 px-1 py-0.5">
                            <div className="mb-0.5 flex justify-between gap-1 text-[8px] font-bold"><span className="truncate">ランニングスコア（得点時の背番号）</span><span>100点</span></div>
                            <div className="grid gap-0" style={{ gridTemplateColumns: 'repeat(50, minmax(0, 1fr))' }}>{Array.from({length:100}, (_, i) => {
                              const item = runners[i]
                              return <div key={i} className="min-w-0 border border-slate-300 text-center leading-none"><div className="text-[6px] text-slate-500">{i+1}</div><div className="h-3 truncate text-[8px] font-bold">{item ? item.number : ''}</div></div>
                            })}</div>
                          </div>
                        </div>
                      </div>
                    })}
                    </div>
                  </section>

  }

  if (loading) {
    return <main className="min-h-screen bg-slate-100 p-6">データを読み込んでいます...</main>
  }

  const selectedGame = games.find((game) => game.id === selectedGameId)
  const homeTeam = selectedGame
    ? teams.find((team) => team.id === selectedGame.homeTeamId)
    : undefined
  const awayTeam = selectedGame
    ? teams.find((team) => team.id === selectedGame.awayTeamId)
    : undefined
  // 履歴の絞り込みは teamId だけに依存せず、playerId が所属するチームも確認する。
  // 保存済みデータにチーム情報の揺れがあっても、選手の記録を正しい色のチームに分類する。
  const getHistoryEvents = () => {
    if (!selectedGame || !homeTeam || !awayTeam) return []
    const whiteTeam = selectedGame.homeUniform === 'white' ? homeTeam : awayTeam
    const darkTeam = selectedGame.homeUniform === 'dark' ? homeTeam : awayTeam
    const whitePlayerIds = new Set(whiteTeam.players.map(player => player.id))
    const darkPlayerIds = new Set(darkTeam.players.map(player => player.id))

    return selectedGame.events.filter(event => {
      if (event.cancelled) return false
      const isWhiteEvent = (event.playerId != null && whitePlayerIds.has(event.playerId)) || (!event.playerId && event.teamId === whiteTeam.id)
      const isDarkEvent = (event.playerId != null && darkPlayerIds.has(event.playerId)) || (!event.playerId && event.teamId === darkTeam.id)

      if (isWhiteEvent && historyWhitePlayer !== 'all' && event.playerId !== historyWhitePlayer) return false
      if (isDarkEvent && historyDarkPlayer !== 'all' && event.playerId !== historyDarkPlayer) return false
      return true
    })
  }
  return (
    <main className={`min-h-screen bg-slate-100 py-8 text-slate-900 ${page === 'game-detail' ? 'px-1 sm:px-2' : 'px-4 sm:px-8'}`}>
      <div className={`mx-auto ${page === 'game-detail' ? 'max-w-[1900px]' : 'max-w-5xl'}`}>
        <header className="mb-3">
          <p className="text-sm font-bold uppercase tracking-widest text-blue-700">TEAM LINK</p>
        </header>

        {page !== 'game-detail' && page !== 'game-record' && (
          <nav className="mb-6 grid grid-cols-4 gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => { setPage('teams'); setMessage('') }}
              className={`rounded-xl px-4 py-3 font-bold ${page === 'teams' ? 'bg-blue-700 text-white' : 'border border-slate-300 bg-white text-slate-700'}`}
            >
              チーム管理
            </button>
            <button
              type="button"
              onClick={() => { setPage('games'); setMessage('') }}
              className={`rounded-xl px-4 py-3 font-bold ${page === 'games' ? 'bg-blue-700 text-white' : 'border border-slate-300 bg-white text-slate-700'}`}
            >
              試合管理
            </button>
            <button type="button" onClick={() => { setPage('stats'); setStatsGameIndex(-1); setStatsFullscreen(false); setMessage('') }} className={`rounded-xl px-2 py-3 text-sm font-bold sm:px-4 sm:text-base ${page === 'stats' ? 'bg-blue-700 text-white' : 'border border-slate-300 bg-white text-slate-700'}`}>スタッツ管理</button>
            <button
              type="button"
              onClick={() => { setPage('backup'); setMessage(''); void loadRecoveryData() }}
              className={`rounded-xl px-2 py-3 text-sm font-bold sm:px-4 sm:text-base ${page === 'backup' ? 'bg-blue-700 text-white' : 'border border-slate-300 bg-white text-slate-700'}`}
            >
              設定
            </button>
          </nav>
        )}

        {message && (
          <div role="status" className="mb-5 rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-800">
            {message}
          </div>
        )}

        {page === 'backup' && (
          <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="text-lg font-bold">バックアップ・復元</h2>
            <p className="mt-1 text-sm text-slate-600">チーム・選手・試合記録をファイルに保存します。データはクラウドに送信されません。</p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button type="button" disabled={saving} onClick={() => void handleExportBackup()} className="rounded-xl bg-blue-700 px-5 py-3 font-bold text-white disabled:opacity-50">
                バックアップを保存
              </button>
              <label className="flex cursor-pointer items-center justify-center rounded-xl border border-slate-300 bg-white px-5 py-3 text-center font-bold text-slate-700 hover:bg-slate-50">
                バックアップから復元
                <input type="file" accept=".json,application/json" disabled={saving} onChange={(event) => void handleImportBackup(event)} className="sr-only" />
              </label>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-amber-800">復元前に現在のチーム・試合データを端末内へ自動退避します。端末の故障やブラウザデータ消去には備えられないため、重要な記録は「バックアップを保存」でファイルにも保存してください。</p>
          </section>
        )}

        {page === 'backup' && (
          <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="text-lg font-bold">試合ごとのバックアップ</h2>
            <p className="mt-1 text-sm text-slate-600">試合を1件選び、試合記録・対戦する両チーム・選手名簿をまとめてJSON保存します。取り込み時は既存チームと照合して差分のみ追加します。</p>
            {games.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">バックアップできる試合がありません。</p>
            ) : (
              <div className="mt-4 max-h-80 space-y-2 overflow-y-auto">
                {games.map((game) => (
                  <div key={game.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-slate-500">{formatGameDate((game as DatedGame).gameDate || game.createdAt)}</p>
                      <p className="font-bold">{game.name}</p>
                      <p className="text-sm text-slate-600">{teamLabel(game.homeTeamId)} VS {teamLabel(game.awayTeamId)}</p>
                    </div>
                    <button type="button" disabled={saving} onClick={() => void handleExportSingleGame(game.id)} className="rounded-xl bg-blue-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
                      この試合を保存
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <h3 className="font-bold text-emerald-900">別端末から1試合を取り込む</h3>
              <p className="mt-1 text-sm text-emerald-900">別のタブレットで「この試合を保存」したJSONファイルを選択してください。既存の試合は消さずに追加します。</p>
              <label className="mt-3 inline-flex cursor-pointer items-center justify-center rounded-xl bg-emerald-700 px-5 py-3 font-bold text-white hover:bg-emerald-800">
                1試合を取り込む
                <input type="file" accept=".json,application/json" disabled={saving} onChange={(event) => void handleImportSingleGame(event)} className="sr-only" />
              </label>
              <p className="mt-2 text-xs text-emerald-900">同じ試合IDがある場合は追加を中止します。全件復元とは異なり、既存の試合を置き換えません。</p>
            </div>
          </section>
        )}

        {page === 'backup' && (
          <section className="mb-6 space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="text-lg font-bold">管理用：ゴミ箱・復元履歴</h2>
            <p className="text-sm text-slate-600">この画面は管理用です。現在はログイン権限による制限はありません。共有端末では取り扱いに注意してください。</p>
            <div>
              <h3 className="font-bold">ゴミ箱（{trash.length}件）</h3>
              {trash.length === 0 ? <p className="mt-2 text-sm text-slate-500">ゴミ箱は空です。</p> : (
                <div className="mt-2 space-y-2">
                  {trash.map(item => (
                    <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-3">
                      <span className="text-sm">{item.kind === 'team' ? 'チーム' : '試合'}：{item.name} <span className="text-slate-500">（{new Date(item.deletedAt).toLocaleString('ja-JP')}）</span></span>
                      <div className="flex gap-2">
                        <button type="button" disabled={saving} onClick={() => void handleRestoreTrash(item)} className="rounded-lg bg-blue-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">復元</button>
                        <button type="button" disabled={saving} onClick={() => void handlePermanentDelete(item)} className="rounded-lg border border-red-200 px-3 py-2 text-sm font-bold text-red-700 disabled:opacity-50">完全削除</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <h3 className="font-bold">復元前の自動バックアップ（{restoreSnapshots.length}件）</h3>
              <p className="mt-1 text-xs text-slate-500">バックアップ復元の直前に端末内へ保存したデータです。</p>
              {restoreSnapshots.length === 0 ? <p className="mt-2 text-sm text-slate-500">まだ自動バックアップはありません。</p> : (
                <div className="mt-2 space-y-2">
                  {restoreSnapshots.map(snapshot => (
                    <div key={snapshot.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-3">
                      <span className="text-sm">{new Date(snapshot.createdAt).toLocaleString('ja-JP')}（チーム{snapshot.teams.length}件・試合{snapshot.games.length}件）</span>
                      <button type="button" disabled={saving} onClick={() => void handleRestoreSnapshot(snapshot)} className="rounded-lg border border-blue-700 px-3 py-2 text-sm font-bold text-blue-700 disabled:opacity-50">この状態に戻す</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {page === 'teams' && (
          <>
            <section className="mb-8 rounded-2xl bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-xl font-bold">チームを作成</h2>
              <p className="mt-1 text-sm text-slate-500">背番号00、0、1〜99の選手が自動作成されます。</p>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <input
                  value={teamName}
                  onChange={(event) => setTeamName(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void handleCreateTeam() }}
                  placeholder="チーム名"
                  maxLength={60}
                  className="min-w-0 flex-1 rounded-xl border border-slate-300 px-4 py-3"
                />
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleCreateTeam()}
                  className="rounded-xl bg-blue-700 px-6 py-3 font-bold text-white disabled:opacity-50"
                >
                  {saving ? '保存中...' : 'チームを作成'}
                </button>
              </div>
            </section>

            <section>
              <h2 className="mb-4 text-2xl font-bold">チーム一覧（{teams.length}）</h2>
              {teams.length === 0 ? (
                <p className="rounded-xl bg-white p-6 text-slate-500">まずはチームを作成してください。</p>
              ) : (
                <div className="space-y-4">
                  {teams.map((team) => (
                    <article key={team.id} className="overflow-hidden rounded-2xl bg-white shadow-sm">
                      <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => toggleFavoriteTeam(team.id)}
                              aria-label={`${team.name}をお気に入り${favoriteTeamIdSet.has(team.id) ? 'から解除' : 'に登録'}`}
                              aria-pressed={favoriteTeamIdSet.has(team.id)}
                              title={favoriteTeamIdSet.has(team.id) ? 'お気に入り解除' : 'お気に入り登録'}
                              className={`shrink-0 rounded-lg p-1 text-2xl leading-none transition-colors ${favoriteTeamIdSet.has(team.id) ? 'text-amber-500' : 'text-slate-300 hover:text-amber-400'}`}
                            >
                              {favoriteTeamIdSet.has(team.id) ? '★' : '☆'}
                            </button>
                            <h3 className="text-xl font-bold">{team.name}</h3>
                          </div>
                          <p className="mt-1 text-sm text-slate-500">選手 {team.players.length} 名分</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => setExpandedTeamId(expandedTeamId === team.id ? null : team.id)}
                            className="rounded-lg border border-blue-700 px-4 py-2 font-semibold text-blue-700"
                          >
                            {expandedTeamId === team.id ? '閉じる' : '選手を管理'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteTeam(team)}
                            className="rounded-lg border border-red-200 px-4 py-2 font-semibold text-red-700"
                          >
                            削除
                          </button>
                        </div>
                      </div>
                      {expandedTeamId === team.id && (
                        <div className="border-t border-slate-200 p-4 sm:p-5">
                          <h4 className="mb-3 font-bold">選手名の編集</h4>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {team.players.map((player) => (
                              <label key={player.id} className="flex items-center gap-3 rounded-xl border border-slate-200 p-3">
                                <span className="w-12 shrink-0 text-center font-bold">#{player.number}</span>
                                <input
                                  key={`${player.id}-${player.name}`}
                                  defaultValue={player.name}
                                  aria-label={`背番号${player.number}の選手名`}
                                  maxLength={40}
                                  onBlur={(event) => {
                                    const newName = event.target.value.trim()
                                    if (newName && newName !== player.name) {
                                      void handlePlayerNameChange(team, player.id, newName)
                                    } else if (!newName) {
                                      event.target.value = player.name
                                    }
                                  }}
                                  className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2"
                                />
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {page === 'games' && (
          <>
            <section className="mb-5 rounded-2xl bg-white p-4 shadow-sm">
              <h2 className="text-lg font-bold">新しい試合を作成</h2>
              <p className="mt-0.5 text-xs text-slate-500">対戦チームとユニフォームを設定します。</p>
              {teams.length < 2 ? (
                <div className="mt-4 rounded-xl bg-amber-50 p-4 text-amber-900">
                  試合を作成するには、先に「チーム管理」で2チーム以上作成してください。
                  <button type="button" onClick={() => setPage('teams')} className="mt-3 block font-bold underline">
                    チーム管理へ
                  </button>
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-10 gap-3">
                    <label className="col-span-7 block min-w-0">
                      <span className="mb-1 block text-sm font-semibold">試合名（任意）</span>
                      <input
                      value={gameName}
                      onChange={(event) => setGameName(event.target.value)}
                      maxLength={100}
                      placeholder="例：練習試合 10/18"
                      className="w-full min-w-0 rounded-xl border border-slate-300 px-3 py-2"
                      />
                    </label>
                    <label className="col-span-3 block min-w-0">
                      <span className="mb-1 block text-sm font-semibold">試合日</span>
                      <input type="date" required value={gameDate} onChange={(event) => setGameDate(event.target.value)} className="w-full min-w-0 rounded-xl border border-slate-300 bg-white px-2 py-2 text-sm" />
                    </label>
                  </div>
                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-2 block font-semibold">ホームチーム</span>
                      <select value={homeTeamId} onChange={(event) => setHomeTeamId(event.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3">
                        <option value="">チームを選択</option>
                        {teamsForSelection.map((team) => <option key={team.id} value={team.id}>{favoriteTeamIdSet.has(team.id) ? '★ ' : ''}{team.name}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-2 block font-semibold">アウェイチーム</span>
                      <select value={awayTeamId} onChange={(event) => setAwayTeamId(event.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3">
                        <option value="">チームを選択</option>
                        {teamsForSelection.map((team) => <option key={team.id} value={team.id}>{favoriteTeamIdSet.has(team.id) ? '★ ' : ''}{team.name}</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-2 block font-semibold">ホームのユニフォーム</span>
                      <select value={homeUniform} onChange={(event) => setHomeUniform(event.target.value as 'white' | 'dark')} className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3">
                        <option value="white">白</option>
                        <option value="dark">濃色</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-2 block font-semibold">アウェイのユニフォーム</span>
                      <select value={awayUniform} onChange={(event) => setAwayUniform(event.target.value as 'white' | 'dark')} className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3">
                        <option value="white">白</option>
                        <option value="dark">濃色</option>
                      </select>
                    </label>
                  </div>
                  <button type="button" disabled={saving} onClick={() => void handleCreateGame()} className="w-full rounded-xl bg-blue-700 px-6 py-4 font-bold text-white disabled:opacity-50">
                    {saving ? '保存中...' : '試合を作成して保存'}
                  </button>
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-4 text-2xl font-bold">試合一覧（{games.length}）</h2>
              {games.length === 0 ? (
                <p className="rounded-xl bg-white p-6 text-slate-500">まだ試合がありません。上のフォームから作成してください。</p>
              ) : (
                <div className="space-y-2">
                  {games.map((game) => (
                    <article key={game.id} className="rounded-2xl bg-white px-4 py-3 shadow-sm">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <h3 className="text-lg font-bold">{game.name}</h3>
                          <p className="mt-1 text-sm text-slate-700">
                            {teamLabel(game.homeTeamId)} <span className="px-2 font-bold text-slate-400">VS</span> {teamLabel(game.awayTeamId)}
                          </p>
                          <p className="mt-1 text-sm text-slate-500">試合日：{(game as DatedGame).gameDate ? (game as DatedGame).gameDate!.replace(/-/g, '/') : new Date(game.createdAt).toLocaleDateString('ja-JP')}</p>
                          {game.status === 'completed' && (
                            <p className="mt-2 inline-flex rounded-full bg-slate-100 px-3 py-1.5 text-base font-bold text-slate-700">試合終了 · 最終スコア：{game.events.filter(e => !e.cancelled && e.teamId === game.homeTeamId && (e.type === 'shot' || e.type === 'freeThrow') && e.made).reduce((sum, e) => sum + (e.points ?? (e.type === 'freeThrow' ? 1 : 0)), 0)} - {game.events.filter(e => !e.cancelled && e.teamId === game.awayTeamId && (e.type === 'shot' || e.type === 'freeThrow') && e.made).reduce((sum, e) => sum + (e.points ?? (e.type === 'freeThrow' ? 1 : 0)), 0)}</p>
                          )}
                        </div>
                        <div className="flex w-full flex-col gap-2 sm:w-64 sm:shrink-0">
                          <button type="button" onClick={() => openGame(game)} className="rounded-lg bg-blue-700 px-3 py-2.5 text-sm font-bold text-white">
                            試合を開く・先発設定
                          </button>
                          <div className="grid grid-cols-2 items-end gap-2">
                            <label className="min-w-0 text-xs font-semibold">
                              試合状況
                              <select aria-label="試合状況" value={game.status} onChange={(event) => void handleGameStatusChange(game, event.target.value as Game['status'])} className="mt-1 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm">
                                <option value="scheduled">試合前</option>
                                <option value="in-progress">試合中</option>
                                <option value="completed">試合終了</option>
                              </select>
                            </label>
                            <button type="button" onClick={() => void handleDeleteGame(game)} className="rounded-lg border border-red-200 px-2 py-2 text-sm font-semibold text-red-700">
                              試合を削除
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {page === 'stats' && (() => {
          const statsGames = [...games].sort((a, b) => {
            const dateOf = (item: Game) => (item as DatedGame).gameDate || item.createdAt.slice(0, 10)
            return dateOf(b).localeCompare(dateOf(a)) || b.createdAt.localeCompare(a.createdAt)
          })
          const index = statsGameIndex < 0 ? Math.max(0, statsGames.length - 1) : Math.min(statsGameIndex, Math.max(0, statsGames.length - 1))
          const game = statsGames[index]
          const statsHome = game ? teams.find(team => team.id === game.homeTeamId) : undefined
          const statsAway = game ? teams.find(team => team.id === game.awayTeamId) : undefined
          return <section className="space-y-4">
            <div className="rounded-2xl bg-white p-3 shadow-sm sm:p-4">
              {statsGames.length === 0 ? <p className="mt-2 text-slate-500">まだ試合がありません。「試合管理」から試合を作成してください。</p> : <>
                <div className="flex items-center justify-between gap-2">
                  <button type="button" aria-label="前の試合" disabled={index === 0} onClick={() => setStatsGameIndex(index - 1)} className="rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-2xl font-black disabled:opacity-30">〈</button>
                  <div className="min-w-0 flex-1 text-center">
                    <p className="text-xs text-slate-500">{index + 1} / {statsGames.length} 試合</p>
                    <p className="truncate text-sm font-normal text-slate-400">{formatGameDate((game as DatedGame).gameDate ?? game.createdAt)}　{game.name}</p>
                    <p className="text-lg font-black leading-snug text-slate-900 sm:text-xl">{teamLabel(game.homeTeamId)} VS {teamLabel(game.awayTeamId)}</p>
                  </div>
                  <button type="button" aria-label="次の試合" disabled={index >= statsGames.length - 1} onClick={() => setStatsGameIndex(index + 1)} className="rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-2xl font-black disabled:opacity-30">〉</button>
                </div>
                <label className="mt-2 block text-sm font-semibold">試合を直接選択
                  <select value={index} onChange={e => setStatsGameIndex(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2">
                    {statsGames.map((item, i) => <option key={item.id} value={i}>{formatGameDate((item as DatedGame).gameDate ?? item.createdAt)}　{item.name}</option>)}
                  </select>
                </label>
              </>}
            </div>
            {game && statsHome && statsAway && <>
              <div className="rounded-2xl bg-white p-3 shadow-sm">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-lg font-bold">スコア表示</h3>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setStatsFullscreen(true)} className="rounded-lg bg-blue-700 px-3 py-2 text-sm font-bold text-white">⛶ 全画面表示</button>
                    <button type="button" disabled={pdfPreparing} onClick={() => shareScoreSheetPdf(game, true)} className="rounded-lg bg-blue-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">{pdfPreparing ? '準備中…' : '① PDFを準備'}</button>
                    {preparedPdf?.gameId === game.id && <>
                      <button type="button" disabled={pdfPreparing} onClick={() => sharePdfFile(preparedPdf.file)} className="rounded-lg bg-green-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">共有</button>
                      <button type="button" disabled={pdfPreparing} onClick={() => savePdfFile(preparedPdf.file)} className="rounded-lg bg-red-600 px-3 py-2 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-50">PDF保存</button>
                    </>}
                  </div>
                </div>
                <div ref={statsSheetContainerRef} className="w-full overflow-hidden rounded-lg border border-slate-200">
                  <div style={{ height: `${900 * statsSheetScale}px`, width: '100%', position: 'relative' }}>
                    <div style={{ width: '1000px', height: '900px', transform: `scale(${statsSheetScale})`, transformOrigin: 'top left', position: 'absolute', top: 0, left: 0 }}>
                      {renderOriginalSheet(game, statsHome, statsAway, true)}
                    </div>
                  </div>
                </div>
              </div>
              <div className="rounded-2xl bg-white p-3 shadow-sm stats-box-score">{renderBoxScore(game, statsHome, statsAway)}</div>
              {statsFullscreen && <div className="fixed inset-0 z-[100] flex h-[100dvh] w-[100vw] flex-col overflow-hidden bg-white" role="dialog" aria-modal="true" aria-label="スタッツ管理 全画面">
                <div className="flex shrink-0 items-center justify-end gap-2 border-b border-slate-200 bg-white px-2 py-2 sm:px-3">
                  <button type="button" disabled={pdfPreparing} onClick={() => shareScoreSheetPdf(game, true)} className="rounded-xl bg-blue-700 px-4 py-3 text-base font-bold text-white shadow-sm disabled:opacity-50">{pdfPreparing ? '準備中…' : '① PDFを準備'}</button>
                  {preparedPdf?.gameId === game.id && <>
                    <button type="button" disabled={pdfPreparing} onClick={() => sharePdfFile(preparedPdf.file)} className="rounded-xl bg-green-700 px-4 py-3 text-base font-bold text-white shadow-sm disabled:opacity-50">共有</button>
                    <button type="button" disabled={pdfPreparing} onClick={() => savePdfFile(preparedPdf.file)} className="rounded-xl bg-red-600 px-4 py-3 text-base font-bold text-white shadow-sm hover:bg-red-700 disabled:opacity-50">PDF保存</button>
                  </>}
                  <button type="button" onClick={() => setStatsFullscreen(false)} className="rounded-xl border border-slate-400 bg-slate-50 px-6 py-3 text-lg font-bold shadow-sm sm:px-8">× 閉じる</button>
                </div>
                <div className="min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
                  <div className="w-full bg-white">
                    <div className="w-full [&>section]:!h-full [&>section]:!min-w-0" style={{ height: 'calc(100dvh - 68px)' }}>
                      {renderOriginalSheet(game, statsHome, statsAway, true)}
                    </div>
                  </div>
                  <div className="w-full border-t-2 border-slate-300 bg-white p-1 sm:p-2 stats-box-score">
                    {renderBoxScore(game, statsHome, statsAway)}
                  </div>
                </div>
              </div>}
            </>}
            {game && (!statsHome || !statsAway) && <p className="rounded-xl bg-white p-4 text-red-700">この試合のチーム情報が見つかりません。</p>}
          </section>
        })()}

        {page === 'game-detail' && (
          <section className="rounded-2xl bg-white p-1 shadow-sm sm:p-2">
            <button
              type="button"
              onClick={() => { setPage('games'); setMessage('') }}
              className="mb-5 rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-700"
            >
              ← 試合一覧に戻る
            </button>
            {!selectedGame || !homeTeam || !awayTeam ? (
              <div>
                <h2 className="text-xl font-bold">試合を表示できません</h2>
                <p className="mt-2 text-slate-600">試合またはチームが見つかりません。試合一覧に戻ってください。</p>
              </div>
            ) : (
              <>
                <h2 className="text-2xl font-bold">{selectedGame.name}</h2>
                <p className="mt-2 text-slate-600">
                  {homeTeam.name} <span className="px-2 font-bold text-slate-400">VS</span> {awayTeam.name}
                </p>
                <p className="mt-2 text-sm text-slate-500">各チームのこのクォーターの出場選手を5人選択してください。</p>
                <div className="mt-4 grid grid-cols-1 gap-2 lg:grid-cols-2">
                  {([
                    { side: 'home' as const, team: homeTeam, lineup: homeLineup, label: 'ホーム' },
                    { side: 'away' as const, team: awayTeam, lineup: awayLineup, label: 'アウェイ' },
                  ]).map(({ side, team, lineup, label }) => (
                    <div key={side} className="min-w-0 rounded-xl border border-slate-200 p-1 sm:p-2">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <h3 className="text-lg font-bold">{label}：{team.name}</h3>
                        <span className={`rounded-full px-3 py-1 text-sm font-bold ${lineup.length === 5 ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-700'}`}>
                          {lineup.length}/5人
                        </span>
                      </div>
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-slate-500">カードを押すと選択・解除できます。各チーム最大5人です。</p><button type="button" disabled={lineup.length === 0 || saving} onClick={() => { side === 'home' ? setHomeLineup([]) : setAwayLineup([]); setMessage('') }} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 disabled:opacity-40">全てクリア</button></div>
                      <div className="grid grid-cols-10 gap-1">
                        {sortPlayersForSelection(team.players).map((player) => {
                          const checked = lineup.includes(player.id)
                          const disabled = !checked && lineup.length >= 5
                          return (
                            <button
                              key={player.id}
                              type="button"
                              disabled={disabled}
                              onClick={() => toggleLineup(player.id, side)}
                              aria-pressed={checked}
                              className={`min-w-0 rounded-lg border px-1 py-3 text-center transition-colors ${checked ? 'border-blue-700 bg-blue-700 text-white' : 'border-slate-200 bg-white text-slate-800'} ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
                            >
                              <span className="block font-bold">#{player.number}</span>
                              <span className="block truncate text-xs">{checked ? '選択中' : player.name}</span>
                            </button>
                          )
                        })}
                      </div>
                      {lineup.length === 5 && (
                        <p className="mt-2 text-xs text-slate-500">5人選択済みです。変更する場合は選択中のカードを押して解除してください。</p>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSaveLineups()}
                  className="mt-6 w-full rounded-xl bg-blue-700 px-6 py-4 font-bold text-white disabled:opacity-50"
                >
                  {saving ? '保存中...' : `${quarterLabel(lineupSetupQuarter)}の出場メンバーを保存して試合へ`}
                </button>
              </>
            )}
          </section>
        )}

        {substitutionTeamId && page === 'game-record' && selectedGame && (() => {
          const team = teams.find(item => item.id === substitutionTeamId)
          if (!team) return null
          const side = team.id === selectedGame.homeTeamId ? 'home' : 'away'
          const lineups = (selectedGame as Game & { quarterLineups?: Record<number, { home: string[]; away: string[] }> }).quarterLineups ?? {}
          const original = lineups[selectedGame.currentQuarter]?.[side] ?? (side === 'home' ? selectedGame.homeLineup ?? [] : selectedGame.awayLineup ?? [])
          const changes = substitutionLineup.filter(id => !original.includes(id)).length
          return (
            <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-1 sm:p-2" role="dialog" aria-modal="true" aria-label="出場選手の交代">
              <div className="flex max-h-[97dvh] w-full max-w-[1600px] flex-col rounded-2xl bg-white p-2 shadow-2xl sm:p-3">
                <div className="mb-3 flex shrink-0 items-center justify-between gap-2">
                  <div>
                    <h3 className="text-lg font-black">交代：{team.name}</h3>
                    <p className="text-xs text-slate-500">出場する5人を選択してください。青色が選択中です。</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-3 py-1 text-sm font-bold ${substitutionLineup.length === 5 ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-700'}`}>{substitutionLineup.length}/5人</span>
                </div>
                <div className="mb-2 flex shrink-0 justify-end">
                  <button type="button" disabled={saving || substitutionLineup.length === 0} onClick={() => { setSubstitutionLineup([]); setMessage('') }} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 disabled:opacity-40">全てクリア</button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                  <div className="grid grid-cols-10 gap-1">
                    {sortPlayersForSelection(team.players).map(player => {
                      const checked = substitutionLineup.includes(player.id)
                      const disabled = !checked && substitutionLineup.length >= 5
                      return <button key={player.id} type="button" disabled={disabled || saving} onClick={() => toggleSubstitutionPlayer(player.id)} aria-pressed={checked}
                        className={`min-w-0 rounded-lg border px-1 py-2 text-center transition-colors ${checked ? 'border-blue-700 bg-blue-700 text-white' : 'border-slate-200 bg-white text-slate-800'} ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}>
                        <span className="block text-sm font-black sm:text-base">#{player.number}</span>
                        <span className="block truncate text-[10px] sm:text-xs">{checked ? '選択中' : player.name}</span>
                      </button>
                    })}
                  </div>
                </div>
                <div className="mt-3 grid shrink-0 grid-cols-3 gap-2 border-t border-slate-200 pt-3">
                  <button type="button" disabled={saving} onClick={() => setSubstitutionTeamId(null)} className="min-w-0 rounded-lg border border-slate-300 px-2 py-3 font-bold">キャンセル</button>
                  <button type="button" disabled={saving || substitutionLineup.length !== 5} onClick={() => void handleSaveSubstitution()} className="col-span-2 min-w-0 rounded-lg bg-blue-700 px-2 py-3 font-black text-white disabled:opacity-40">
                    {saving ? '保存中…' : `登録${changes ? `（${changes}人交代）` : ''}`}
                  </button>
                </div>
              </div>
            </div>
          )
        })()}

        {page === 'game-record' && (
          <section className="rounded-2xl bg-white p-2 shadow-sm sm:p-3">
            {!selectedGame || !homeTeam || !awayTeam ? (
              <div>
                <h2 className="text-xl font-bold">試合を表示できません</h2>
                <button type="button" onClick={() => setPage('games')} className="mt-4 rounded-lg border px-4 py-2">試合一覧に戻る</button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-lg font-bold">{selectedGame.name}</h2>
                <p className="mt-1 inline-flex rounded-md bg-blue-700 px-2 py-1 text-sm font-black text-white">{quarterLabel(lineupSetupQuarter)}</p>
                    <p className="mt-0.5 text-sm text-slate-600">{homeTeam.name} vs {awayTeam.name}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {selectedGame.status === 'completed' ? (
                      <span className="rounded-full bg-slate-100 px-3 py-2 text-sm font-bold text-slate-700">試合終了</span>
                    ) : (
                      <button type="button" disabled={saving} onClick={() => void handleFinishGame()} className="rounded-lg bg-red-600 px-4 py-2 font-bold text-white disabled:opacity-50">試合終了</button>
                    )}
                    <button type="button" onClick={() => { setPage('games'); setMessage('') }} className="rounded-lg border border-slate-300 px-4 py-2 font-semibold">試合一覧に戻る</button>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
                  <button type="button" onClick={() => setRecordView('official')} className={`rounded-lg px-2 py-2 text-sm font-bold sm:text-base ${recordView === 'official' ? 'bg-blue-700 text-white' : 'bg-white text-slate-700'}`}>スタッツ入力</button>
                  <button type="button" onClick={() => setRecordView('original')} className={`rounded-lg px-2 py-2 text-sm font-bold sm:text-base ${recordView === 'original' ? 'bg-blue-700 text-white' : 'bg-white text-slate-700'}`}>スコア表示</button>
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs">
                  <label htmlFor="timeout-limit" className="font-semibold">設定：各クォーターのタイムアウト上限</label>
                  <select id="timeout-limit" value={timeoutLimit} onChange={e => { const value = Number(e.target.value); setTimeoutLimit(value); localStorage.setItem('team-link-timeout-limit', String(value)); setMessage(`タイムアウト上限を各クォーター${value}回に設定しました。`) }} className="rounded border border-slate-300 bg-white px-2 py-1">
                    <option value={1}>1回</option><option value={2}>2回</option><option value={3}>3回</option>
                  </select>
                </div>
                {recordView === 'official' && (
                  <>
                <div className="sticky top-0 z-20 mt-2 grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-xl bg-slate-900 p-1.5 text-white shadow-md">
                  <button type="button" disabled={selectedGame.status === 'completed' || selectedGame.events.filter(e => !e.cancelled && e.type === 'timeout' && e.teamId === homeTeam.id && e.quarter === selectedGame.currentQuarter).length >= timeoutLimit} onClick={() => void handleTimeout(homeTeam.id)} className="rounded-lg bg-indigo-600 px-2 py-3 text-xs font-black active:translate-y-0.5 active:bg-indigo-800 disabled:bg-slate-600">TO<br/>HOME</button>
                  <div className="min-w-0 text-center"><p className="truncate text-center text-sm font-bold text-slate-200">{homeTeam.name}</p><div className="mt-1 flex items-center justify-center gap-2 text-[10px]"><TeamFoulIndicator count={selectedGame.events.filter(e => !e.cancelled && e.type === 'foul' && e.teamId === homeTeam.id && e.quarter === selectedGame.currentQuarter).length} /><span className="whitespace-nowrap text-slate-300">TO {selectedGame.events.filter(e => !e.cancelled && e.type === 'timeout' && e.teamId === homeTeam.id && e.quarter === selectedGame.currentQuarter).length}/{timeoutLimit}</span></div></div>
                  <p className="px-1 text-3xl font-black tabular-nums">{selectedGame.events.filter(e => !e.cancelled && e.teamId === homeTeam.id && (e.type === 'shot' || e.type === 'freeThrow') && e.made).reduce((sum, e) => sum + (e.points ?? 0), 0)}</p>
                  <div className="px-1 text-center"><p className="whitespace-nowrap text-xs font-bold text-slate-300">＜{quarterLabel(selectedGame.currentQuarter)}＞</p>{selectedGame.status !== 'completed' && selectedGame.currentQuarter < 6 && <button type="button" onClick={() => void handleQuarterChange(selectedGame.currentQuarter + 1)} className="mt-0.5 whitespace-nowrap rounded-md bg-white px-2 py-1 text-[11px] font-black text-slate-900">次のQ⇒</button>}</div>
                  <p className="px-1 text-3xl font-black tabular-nums">{selectedGame.events.filter(e => !e.cancelled && e.teamId === awayTeam.id && (e.type === 'shot' || e.type === 'freeThrow') && e.made).reduce((sum, e) => sum + (e.points ?? 0), 0)}</p>
                  <div className="min-w-0 text-center"><p className="truncate text-center text-sm font-bold text-slate-200">{awayTeam.name}</p><div className="mt-1 flex items-center justify-center gap-2 text-[10px]"><TeamFoulIndicator count={selectedGame.events.filter(e => !e.cancelled && e.type === 'foul' && e.teamId === awayTeam.id && e.quarter === selectedGame.currentQuarter).length} /><span className="whitespace-nowrap text-slate-300">TO {selectedGame.events.filter(e => !e.cancelled && e.type === 'timeout' && e.teamId === awayTeam.id && e.quarter === selectedGame.currentQuarter).length}/{timeoutLimit}</span></div></div>
                  <button type="button" disabled={selectedGame.status === 'completed' || selectedGame.events.filter(e => !e.cancelled && e.type === 'timeout' && e.teamId === awayTeam.id && e.quarter === selectedGame.currentQuarter).length >= timeoutLimit} onClick={() => void handleTimeout(awayTeam.id)} className="rounded-lg bg-indigo-600 px-2 py-3 text-xs font-black active:translate-y-0.5 active:bg-indigo-800 disabled:bg-slate-600">TO<br/>AWAY</button>
                </div>
                {selectedGame.status === 'completed' && <p className="mt-5 rounded-xl bg-slate-100 p-3 font-semibold text-slate-700">この試合は終了済みです。以下は保存された記録の閲覧専用です。</p>}
                <p className="mt-2 text-xs font-bold">{selectedGame.status === 'completed' ? '選手・記録（閲覧のみ）' : '選手を選択して記録'}</p>
                <div className="mt-1 grid grid-cols-1 items-start gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)]">
                  {[{team:homeTeam, side:'home' as const, label:'ホーム'}, {team:awayTeam, side:'away' as const, label:'アウェイ'}].map(({team,side,label}) => {
                    const stored = (selectedGame as Game & { quarterLineups?: Record<number, { home: string[]; away: string[] }> }).quarterLineups ?? {}
                    const lineup = stored[selectedGame.currentQuarter]?.[side] ?? (side === 'home' ? selectedGame.homeLineup ?? [] : selectedGame.awayLineup ?? [])
                    return (
                    <div key={team.id} className={`min-w-0 rounded-lg border border-slate-200 p-1.5 ${side === 'home' ? 'order-1' : 'order-3'}`}>
                      <h3 className="mb-1 truncate text-sm font-bold">{label}：{team.name}</h3>
                      <div className="grid grid-cols-1 gap-1">
                        {team.players.filter(player => lineup.includes(player.id)).map(player => (
                          <button key={player.id} type="button" onClick={() => selectedGame.status !== 'completed' && setSelectedPlayerId(player.id)} disabled={selectedGame.status === 'completed'} className={`rounded-lg border-2 px-3 py-3.5 text-left text-lg font-bold ${selectedPlayerId === player.id ? 'border-blue-700 bg-blue-50 ring-2 ring-blue-200' : 'border-slate-200 bg-white'}`}>
                            <span className="flex w-full items-center gap-2"><span className="shrink-0 font-bold">#{player.number}</span><span className="min-w-0 flex-1 truncate">{player.name}</span>{selectedPlayerId === player.id && <span className="shrink-0 text-xs font-bold text-blue-700">選択中</span>}<span className="ml-auto shrink-0 min-w-6 text-right font-black text-red-600 leading-none border-0 rounded-none bg-transparent p-0 shadow-none" style={{ fontSize: '30px', lineHeight: 1, border: 'none', borderRadius: 0, padding: 0, background: 'transparent' }}>{(() => { const count = selectedGame.events.filter(e => !e.cancelled && e.type === 'foul' && e.playerId === player.id).length; return count > 0 ? String(count) : ''; })()}</span></span>
                          </button>
                        ))}
                      </div>
                      {selectedGame.status !== 'completed' && (
                        <button type="button" onClick={() => openSubstitution(team.id, lineup)} className="mt-2 w-full rounded-lg bg-amber-600 px-3 py-3.5 text-lg font-black text-white shadow active:translate-y-0.5">
                          交代
                        </button>
                      )}
                    </div>
                    )
                  })}
                {(() => {
                  const player = [...homeTeam.players, ...awayTeam.players].find(p => p.id === selectedPlayerId)
                  const team = homeTeam.players.some(p => p.id === selectedPlayerId) ? homeTeam : awayTeam
                  return (
                    <div className="order-2 min-w-0 rounded-lg border border-blue-200 bg-blue-50 p-2 lg:sticky lg:top-[5.5rem] lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto">
                      <p className="truncate text-sm font-bold">{player ? `${team.name}：#${player.number} ${player.name}` : '先に記録する選手を選んでください'}</p>
                      <div className="mt-1 grid grid-cols-2 gap-1">
                        <button type="button" disabled={!player || selectedGame.status === 'completed'} onClick={() => { if (player) void handleRecordEvent(team.id, player.id, 'shot', 2, true) }} className="rounded-lg bg-blue-700 px-2 py-4 text-lg font-black text-white shadow-md transition active:translate-y-0.5 active:scale-[0.98] active:bg-blue-900 disabled:opacity-40">2点成功</button>
                        <button type="button" disabled={!player || selectedGame.status === 'completed'} onClick={() => { if (player) void handleRecordEvent(team.id, player.id, 'shot', 3, true) }} className="rounded-lg bg-blue-700 px-2 py-4 text-lg font-black text-white shadow-md transition active:translate-y-0.5 active:scale-[0.98] active:bg-blue-900 disabled:opacity-40">3点成功</button>
                        <button type="button" disabled={!player || selectedGame.status === 'completed'} onClick={() => { if (player) void handleRecordEvent(team.id, player.id, 'shot', 2, false) }} className="rounded-lg border-2 border-red-300 bg-red-50 px-2 py-4 text-lg font-black text-red-700 shadow-md transition active:translate-y-0.5 active:scale-[0.98] active:bg-red-200 disabled:opacity-40">2点失敗</button>
                        <button type="button" disabled={!player || selectedGame.status === 'completed'} onClick={() => { if (player) void handleRecordEvent(team.id, player.id, 'shot', 3, false) }} className="rounded-lg border-2 border-red-300 bg-red-50 px-2 py-4 text-lg font-black text-red-700 shadow-md transition active:translate-y-0.5 active:scale-[0.98] active:bg-red-200 disabled:opacity-40">3点失敗</button>
                        {[{type:'foul' as const,label:'ファウル'},{type:'turnover' as const,label:'ターンオーバー'},{type:'assist' as const,label:'アシスト'}].slice(0, 1).map(item => <button key={item.type} type="button" disabled={!player || selectedGame.status === 'completed'} onClick={() => player && void handleRecordEvent(team.id, player.id, item.type)} className="rounded-lg border border-slate-300 bg-white px-2 py-3.5 text-base font-black shadow-sm transition active:translate-y-0.5 active:bg-slate-200 disabled:opacity-40">{item.label}</button>)}
                        <button type="button" disabled={!player || selectedGame.status === 'completed'} onClick={() => { setFreeThrowCount(2); setFreeThrowResults([null, null]); setFreeThrowModalOpen(true); setMessage('') }} className="rounded-lg border-2 border-emerald-300 bg-emerald-50 px-2 py-3 text-base font-black text-emerald-800 shadow-sm active:translate-y-0.5 active:bg-emerald-100 disabled:opacity-40">フリースロー</button>
                        {[{type:'turnover' as const,label:'ターンオーバー'},{type:'assist' as const,label:'アシスト'},{type:'steal' as const,label:'スティール'},{type:'block' as const,label:'ブロック'},{type:'offensiveRebound' as const,label:'OFリバウンド'},{type:'defensiveRebound' as const,label:'DFリバウンド'}].map(item => <button key={item.type} type="button" disabled={!player || selectedGame.status === 'completed'} onClick={() => player && void handleRecordEvent(team.id, player.id, item.type)} className="rounded-lg border border-slate-300 bg-white px-2 py-3.5 text-base font-black shadow-sm transition active:translate-y-0.5 active:bg-slate-200 disabled:opacity-40">{item.label}</button>)}
                      </div>
                      <div className="mt-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1">
                        {(() => { const event = [...selectedGame.events].reverse().find(e => !e.cancelled); if (!event) return <p className="text-sm font-bold text-slate-600">今の操作：記録なし</p>; const eventTeam = event.teamId === homeTeam.id ? homeTeam : awayTeam; const eventPlayer = [...homeTeam.players, ...awayTeam.players].find(p => p.id === event.playerId); const labels: Record<string,string> = {assist:'アシスト',block:'ブロック',steal:'スティール',offensiveRebound:'OFリバウンド',defensiveRebound:'DFリバウンド',turnover:'ターンオーバー',foul:'ファウル',substitution:'選手交代',timeout:'タイムアウト'}; const label = event.type === 'shot' ? `${event.points ?? 0}点${event.made ? '成功' : '失敗'}` : event.type === 'freeThrow' ? `フリースロー${event.made ? '成功' : '失敗'}` : labels[event.type] ?? event.type; return <p className="truncate text-sm font-black text-blue-900">今の操作：{eventTeam.name} · {eventPlayer ? `#${eventPlayer.number} ${eventPlayer.name}` : 'チーム記録'} · {label}</p> })()}
                      </div>
                      {freeThrowModalOpen && (
                        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="free-throw-title">
                          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
                            <h3 id="free-throw-title" className="text-xl font-black">フリースロー記録</h3>
                            <p className="mt-1 text-sm text-slate-600">{player ? `#${player.number} ${player.name}` : '選手未選択'} · {quarterLabel(selectedGame.currentQuarter)}</p>
                            <div className="mt-4 grid grid-cols-3 gap-2">
                              {([1, 2, 3] as const).map(count => <button key={count} type="button" onClick={() => { setFreeThrowCount(count); setFreeThrowResults(Array(count).fill(null)) }} className={`rounded-lg border px-3 py-3 font-bold ${freeThrowCount === count ? 'border-blue-700 bg-blue-700 text-white' : 'border-slate-300 bg-white'}`}>{count}本{freeThrowCount === count ? '（選択中）' : ''}</button>)}
                            </div>
                            <div className="mt-4 space-y-3">
                              {Array.from({ length: freeThrowCount }, (_, index) => (
                                <div key={index} className="flex items-center gap-3">
                                  <span className="w-16 shrink-0 font-bold">{index + 1}本目</span>
                                  <button type="button" onClick={() => setFreeThrowResults(current => current.map((value, i) => i === index ? true : value))} className={`flex-1 rounded-lg border px-3 py-3 font-bold ${freeThrowResults[index] === true ? 'border-emerald-700 bg-emerald-600 text-white' : 'border-emerald-300 bg-emerald-50 text-emerald-800'}`}>成功</button>
                                  <button type="button" onClick={() => setFreeThrowResults(current => current.map((value, i) => i === index ? false : value))} className={`flex-1 rounded-lg border px-3 py-3 font-bold ${freeThrowResults[index] === false ? 'border-red-700 bg-red-600 text-white' : 'border-red-300 bg-red-50 text-red-700'}`}>失敗</button>
                                </div>
                              ))}
                            </div>
                            <div className="mt-5 flex justify-end gap-2">
                              <button type="button" disabled={saving} onClick={() => setFreeThrowModalOpen(false)} className="rounded-lg border border-slate-300 px-4 py-2 font-bold">キャンセル</button>
                              <button type="button" disabled={saving || freeThrowResults.slice(0, freeThrowCount).some(result => result === null)} onClick={() => void handleSaveFreeThrows()} className="rounded-lg bg-blue-700 px-5 py-2 font-bold text-white disabled:opacity-40">{saving ? '保存中…' : '保存'}</button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })()}
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-slate-500">記録済み：{selectedGame.events.filter(e => !e.cancelled).length}件（自動保存）</p>
                  <button type="button" disabled={selectedGame.status === 'completed'} onClick={() => void handleUndoLastEvent()} className="rounded-lg border border-red-200 px-4 py-2 font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-40">直前の記録を取り消す</button>
                </div>
                <div className="mt-2 rounded-lg border border-slate-200 p-2">
                  <div className="mb-1 flex items-center justify-between gap-2"><h3 className="text-xs font-bold">直近3件</h3><button type="button" onClick={() => setHistoryModalOpen(true)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-bold active:bg-slate-100">履歴一覧・削除</button></div>
                  {selectedGame.events.filter(e => !e.cancelled).slice().reverse().slice(0,3).map(event => {
                    const eventTeam = event.teamId === homeTeam.id ? homeTeam : awayTeam
                    const eventPlayer = [...homeTeam.players, ...awayTeam.players].find(p => p.id === event.playerId)
                    const labels: Record<string,string> = {assist:'アシスト',block:'ブロック',steal:'スティール',offensiveRebound:'OFリバウンド',defensiveRebound:'DFリバウンド',turnover:'ターンオーバー',foul:'ファウル',substitution:'選手交代',timeout:'タイムアウト'}
                    const recordLabel = event.type === 'shot'
                      ? `${event.points ?? 0}点${event.made ? '成功' : '失敗'}`
                      : event.type === 'freeThrow'
                        ? `フリースロー${event.made ? '成功' : '失敗'}`
                        : labels[event.type] ?? event.type
                    return <div key={event.id} className="flex items-center justify-between gap-1 border-b border-slate-100 py-1 text-xs last:border-0"><span className="min-w-0 flex-1">{quarterLabel(event.quarter)} · {eventTeam.name} · #{eventPlayer?.number ?? '?'} {eventPlayer?.name ?? (event.type === 'timeout' ? 'チーム記録' : '選手不明')} <strong className="ml-1">{recordLabel}</strong></span></div>
                  })}
                  {selectedGame.events.filter(e => !e.cancelled).length === 0 && <p className="text-sm text-slate-500">まだ記録はありません。</p>}
                </div>

                {historyModalOpen && (
                  <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-3" role="dialog" aria-modal="true" aria-labelledby="history-title">
                    <div className="flex max-h-[85dvh] w-full max-w-2xl flex-col rounded-xl bg-white p-3 shadow-2xl">
                      <div className="mb-2 flex items-center justify-between gap-2"><h3 id="history-title" className="text-lg font-black">履歴一覧</h3><button type="button" onClick={() => setHistoryModalOpen(false)} className="rounded-lg border px-3 py-2 text-sm font-bold">閉じる</button></div>
                      <p className="mb-2 text-xs text-slate-500">白・濃チームごとに背番号で絞り込めます。記録はこの画面から1件ずつ削除できます。</p>
                      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <label className="block text-sm font-bold text-slate-700">
                          白チーム：背番号
                          <select
                            value={historyWhitePlayer}
                            onChange={event => setHistoryWhitePlayer(event.target.value)}
                            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-normal"
                          >
                            <option value="all">全選手</option>
                            {(selectedGame.homeUniform === 'white' ? homeTeam : awayTeam).players
                              .slice()
                              .sort((a, b) => Number(a.number) - Number(b.number))
                              .map(player => <option key={player.id} value={player.id}>#{player.number} {player.name}</option>)}
                          </select>
                        </label>
                        <label className="block text-sm font-bold text-slate-700">
                          濃チーム：背番号
                          <select
                            value={historyDarkPlayer}
                            onChange={event => setHistoryDarkPlayer(event.target.value)}
                            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-normal"
                          >
                            <option value="all">全選手</option>
                            {(selectedGame.homeUniform === 'dark' ? homeTeam : awayTeam).players
                              .slice()
                              .sort((a, b) => Number(a.number) - Number(b.number))
                              .map(player => <option key={player.id} value={player.id}>#{player.number} {player.name}</option>)}
                          </select>
                        </label>
                      </div>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-600">
                          表示：{getHistoryEvents().length}件
                        </span>
                        <button type="button" onClick={() => { setHistoryWhitePlayer('all'); setHistoryDarkPlayer('all') }} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-bold">フィルター解除</button>
                      </div>
                      <div className="min-h-0 flex-1 overflow-y-auto">
                        {getHistoryEvents().slice().reverse().map(event => {
                          const eventTeam = event.teamId === homeTeam.id ? homeTeam : awayTeam
                          const eventPlayer = [...homeTeam.players, ...awayTeam.players].find(p => p.id === event.playerId)
                          const labels: Record<string,string> = {assist:'アシスト',block:'ブロック',steal:'スティール',offensiveRebound:'OFリバウンド',defensiveRebound:'DFリバウンド',turnover:'ターンオーバー',foul:'ファウル',substitution:'選手交代',timeout:'タイムアウト'}
                          const recordLabel = event.type === 'shot' ? `${event.points ?? 0}点${event.made ? '成功' : '失敗'}` : event.type === 'freeThrow' ? `フリースロー${event.made ? '成功' : '失敗'}` : labels[event.type] ?? event.type
                          return <div key={event.id} className="flex items-center gap-2 border-b border-slate-100 py-2 text-sm last:border-0"><span className="min-w-0 flex-1">{quarterLabel(event.quarter)} · {eventTeam.name} · #{eventPlayer?.number ?? '?'} {eventPlayer?.name ?? (event.type === 'timeout' ? 'チーム記録' : '選手不明')} <strong>{recordLabel}</strong></span><button type="button" disabled={selectedGame.status === 'completed'} onClick={() => void handleDeleteEvent(event.id)} className="shrink-0 rounded-lg border border-red-200 px-3 py-2 text-xs font-black text-red-700 active:bg-red-100 disabled:opacity-40">削除</button></div>
                        })}
                        {getHistoryEvents().length === 0 && <p className="py-6 text-center text-sm text-slate-500">該当する記録はありません。</p>}
                      </div>
                    </div>
                  </div>
                )}
                <section className="mt-2 rounded-lg border border-slate-200 bg-white p-2">
                  <div className="mb-1">
                    <h3 className="text-sm font-bold">クォーター別スコア</h3>
                    <p className="text-xs text-slate-500">クォーターごとの得点</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] border-collapse text-sm">
                      <thead>
                        <tr className="bg-slate-100 text-left">
                          <th className="border-b border-slate-200 px-2 py-1">チーム</th>
                          {visibleQuarters(selectedGame).map(q => <th key={q} className="border-b border-slate-200 px-2 py-1 text-center">{q <= 4 ? `${q}Q` : q === 5 ? 'OT' : '2OT'}</th>)}
                          <th className="border-b border-slate-200 px-2 py-1 text-center">合計</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[{ team: homeTeam, label: 'ホーム' }, { team: awayTeam, label: 'アウェイ' }].map(({ team, label }) => {
                          const validScoringEvents = selectedGame.events.filter(event => !event.cancelled && event.teamId === team.id && (event.type === 'shot' || event.type === 'freeThrow') && event.made)
                          const quarterScores = visibleQuarters(selectedGame).map(q => validScoringEvents.filter(event => event.quarter === q).reduce((sum, event) => sum + (event.points ?? (event.type === 'freeThrow' ? 1 : 0)), 0))
                          const total = quarterScores.reduce((sum, value) => sum + value, 0)
                          return <tr key={team.id} className="border-b border-slate-100 last:border-0"><td className="whitespace-nowrap px-2 py-1 font-semibold">{team.name} <span className="text-xs font-normal text-slate-500">({label})</span></td>{quarterScores.map((value, index) => <td key={index} className="px-2 py-1 text-center tabular-nums">{value}</td>)}<td className="px-2 py-1 text-center font-bold tabular-nums text-blue-700">{total}</td></tr>
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>

                {renderBoxScore(selectedGame, homeTeam, awayTeam)}
              </>
                )}
                {recordView === 'original' && <>
                  <div className="my-2 flex justify-end"></div>
                  {renderOriginalSheet(selectedGame, homeTeam, awayTeam)}
                </>}
              </>
            )}
          </section>
        )}

        <footer className="mt-10 border-t border-slate-200 py-5 text-center text-sm text-slate-500">
          TEAM LINK · バスケットボール管理
        </footer>
      </div>
    </main>
  )
}

export default App
