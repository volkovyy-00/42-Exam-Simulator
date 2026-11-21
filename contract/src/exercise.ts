// Exercise file in CONTENT_DIR/exercises/<level>/<id>.json (DESIGN.md §5).
// JSON Schema twin: contract/schemas/exercise.schema.json. Keep both in sync.
import type { ExerciseKind, SubjectSource } from './api.ts';

export interface ExerciseTest {
  id: string;
  visible: boolean;
  argv: string[];
  stdin: string | null;
  expected_stdout_b64: string;
  expected_exit: number;
}

export interface Exercise {
  id: string;
  level: number;
  kind: ExerciseKind;
  expected_files: string[];
  allowed_functions: string[];
  prototype: string | null;
  subject_md: string;
  subject_source: SubjectSource;
  harness: {
    main: string | null;
    includes: string[];
    cflags_extra: string[];
  };
  tests: ExerciseTest[];
  limits: { timeout_ms: number; max_output_bytes: number };
  reference_path: string;
  provenance: {
    repo: string;
    commit: string | null;
    license_code: string;
    license_subject: string;
  };
  hint_tags: string[];
  allow_asm?: boolean;
}

export interface ContentManifest {
  repo: string;
  commit: string | null;
  generated_at: string;
  count: number;
  ignore_symbols: string[];
}
