package com.pdatahub.hub.mcp

/**
 * Test seam for HubIdentityViewModel — exposes just the GET /v1/identity
 * fetch so unit tests can swap in a fake without mocking OkHttp / Settings.
 */
interface HubIdentitySource {
    suspend fun getIdentity(): IdentityResponse
}

interface DelegationSource {
    suspend fun getDelegations(): DelegationsResponse
    suspend fun revokeDelegation(delegationId: String): Boolean
}
