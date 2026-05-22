import type { AgentConfig } from '@brownstone/contracts';
import type { ControlPlaneCapabilities } from './capabilities.js';

/**
 * Default capabilities — wires the real runtime packages into the
 * control plane. The tsconfig path references mean we get proper type
 * checking on these imports (no more `as any[]` from Pass 1).
 *
 * Tests can build their own ControlPlaneCapabilities object instead of
 * calling this. The interface in capabilities.ts is the contract.
 */
export async function buildCapabilities(config: AgentConfig): Promise<ControlPlaneCapabilities> {
  // Provider
  const { createModelProvider } = await import('@brownstone/providers-openai');
  const provider = await createModelProvider(config);

  // Sessions / runtime
  const { listSessions, loadSession, startSession } = await import('@brownstone/session-store');
  const { runChatTurn, runTurn, builtinTools } = await import('@brownstone/runtime');

  // Tasks
  const { enqueueTask, listTasks, loadTask } = await import('@brownstone/task-queue');
  const { processNextTask } = await import('@brownstone/task-executor');

  // Telemetry
  const { tailEvents, writeEvent } = await import('@brownstone/telemetry');

  // Memory
  const { listMemory } = await import('@brownstone/memory');

  // Browser
  const { requestBrowserCapture, requestBrowserSubmit } = await import('@brownstone/browser-automation');

  // Git
  const { getGitDiff, getGitStatus } = await import('@brownstone/git-tools');

  // Patching
  const { applyPatchPlan, parsePatchPlan, previewPatchPlan } = await import('@brownstone/patching');

  // Search / research
  const { createWebSearchProvider, performWebSearch } = await import('@brownstone/web-search');
  const searchProvider = createWebSearchProvider(config);
  const { answerResearchQuestion, listUploadedDocuments, retrieveUploadedDocuments, saveUploadedText } =
    await import('@brownstone/research');

  // Operations
  const {
    addComment, createExportBundle, createSchedule,
    listApprovals, listComments, listExports, listSchedules,
    recordApproval,
  } = await import('@brownstone/operations');

  return {
    provider,
    runTurn,
    runChatTurn,
    builtinTools,
    startSession,
    listSessions,
    loadSession,
    enqueueTask,
    listTasks,
    loadTask,
    processNextTask: (cfg) => processNextTask(cfg),
    tailEvents,
    writeEvent,
    listMemory,
    getGitStatus,
    getGitDiff,
    parsePatchPlan,
    previewPatchPlan,
    applyPatchPlan,
    browserCapture: requestBrowserCapture,
    browserSubmit: requestBrowserSubmit,
    performWebSearch: (cfg, query) => performWebSearch(cfg, query, searchProvider),
    answerResearchQuestion: (args) => answerResearchQuestion({ ...args, provider, searchProvider }),
    saveUploadedText,
    listUploadedDocuments,
    retrieveUploadedDocuments,
    listSchedules,
    createSchedule,
    addComment,
    listComments,
    listApprovals,
    recordApproval,
    listExports,
    createExportBundle,
  };
}
