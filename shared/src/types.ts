/**
 * SAIP shared type definitions
 */

/** Adapter manifest stored in R2 at adapters/<id>/manifest.json */
export interface AdapterManifest {
  id: string
  base_model: string
  base_revision?: string
  rank: number
  alpha: number
  version: number
  parent?: string
  training_run?: string
  training_method?: 'knowledge_embedding' | 'corrective_sft' | 'weighted_kto'
  metrics?: Record<string, number>
  created_at: string
  updated_at: string
}

/** Global adapter index stored in R2 at adapters/_index.json */
export interface AdapterIndex {
  adapters: Record<string, AdapterManifest>
  aliases: Record<string, string>  // e.g., "general@latest" → "general@000042"
  updated_at: string
}

/** Knowledge manifest stored in R2 at knowledge/<id>/manifest.json */
export interface KnowledgeManifest {
  id: string
  source: string
  source_type: 'document' | 'repository' | 'dataset'
  license?: string
  hash: string
  size_bytes: number
  created_at: string
  updated_at: string
  tags?: string[]
}

/** Session manifest stored in R2 at sessions/<id>/manifest.json */
export interface SessionManifest {
  id: string
  caller: string
  adapter_id: string
  started_at: string
  completed_at?: string
  message_count: number
  artifact_count: number
}

/** Feedback record stored in R2 at feedback/<id>.json */
export interface FeedbackRecord {
  id: string
  session_id: string
  message_id?: string
  reward: number
  confidence?: number
  dimensions?: Record<string, number>
  feedback_text?: string
  created_at: string
}

/** User → adapter mapping entry */
export interface UserEntry {
  id: string
  adapters: {
    inference: string
    training: string
  }
}

/** Platform mode */
export type PlatformMode = 'awake' | 'asleep' | 'down'
