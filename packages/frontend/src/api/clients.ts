import { apiRequest } from './client';
import type { ClientAccess, ClientAccessCreated } from '@cms/shared';

/**
 * Client access management API endpoints (admin only).
 *
 * The backend rejects every call from non-admin sessions with 403.
 */

/** Lists all client accesses (secrets stripped). */
export async function listClients(): Promise<ClientAccess[]> {
  return apiRequest<ClientAccess[]>('/api/clients', {});
}

/** Creates a new client access linked to one repository. */
export async function createClient(input: {
  repoOwner: string;
  repoName: string;
  label: string;
  /** Preferred UI language for this client; omitted = browser default. */
  language?: 'en' | 'fr';
}): Promise<ClientAccessCreated> {
  return apiRequest<ClientAccessCreated>('/api/clients', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Resets a client's password; the new password is returned once. */
export async function resetClientPassword(clientId: string): Promise<{ password: string }> {
  return apiRequest<{ password: string }>(`/api/clients/${encodeURIComponent(clientId)}/reset-password`, {
    method: 'POST',
  });
}

/** Revokes a client access (the record is kept, sign-in is blocked). */
export async function revokeClient(clientId: string): Promise<ClientAccess> {
  return apiRequest<ClientAccess>(`/api/clients/${encodeURIComponent(clientId)}/revoke`, {
    method: 'POST',
  });
}

/** Sets a client's preferred UI language. */
export async function updateClientLanguage(clientId: string, language: 'en' | 'fr'): Promise<ClientAccess> {
  return apiRequest<ClientAccess>(`/api/clients/${encodeURIComponent(clientId)}/language`, {
    method: 'POST',
    body: JSON.stringify({ language }),
  });
}

/** Permanently deletes a client access. */
export async function deleteClient(clientId: string): Promise<void> {
  await apiRequest<{ success: boolean }>(`/api/clients/${encodeURIComponent(clientId)}`, {
    method: 'DELETE',
  });
}
