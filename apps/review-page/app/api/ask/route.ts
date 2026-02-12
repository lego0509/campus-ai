// /api/ask は /api/review-ask と同一実装を使う。
// これで DB検索ロジックの二重管理を避け、挙動差分を防ぐ。
export { runtime, dynamic, POST } from '../review-ask/route';
