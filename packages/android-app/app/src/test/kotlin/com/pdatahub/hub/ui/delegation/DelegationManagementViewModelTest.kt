package com.pdatahub.hub.ui.delegation

import com.pdatahub.hub.mcp.DelegationGranted
import com.pdatahub.hub.mcp.DelegationSource
import com.pdatahub.hub.mcp.DelegationsResponse
import com.pdatahub.hub.mcp.HttpException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DelegationManagementViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `init refresh surfaces granted and received lists`() = runTest(dispatcher) {
        val source = FakeDelegationSource(
            response = DelegationsResponse(
                granted = listOf(sample("d1", revoked = 0)),
                received = emptyList(),
            )
        )
        val vm = DelegationManagementViewModel(source)
        advanceUntilIdle()
        val s = vm.state.value as DelegationListUiState.Loaded
        assertEquals(1, s.granted.size)
        assertEquals(0, s.received.size)
        assertEquals("d1", s.granted[0].delegation_id)
        assertEquals(false, s.granted[0].isRevoked)
    }

    @Test
    fun `init refresh transitions through Loading`() = runTest(dispatcher) {
        val source = FakeDelegationSource(response = DelegationsResponse())
        val vm = DelegationManagementViewModel(source)
        val intermediate = vm.state.value
        assertTrue(
            "expected Loading immediately, got $intermediate",
            intermediate is DelegationListUiState.Loading,
        )
    }

    @Test
    fun `init refresh failure surfaces Error state`() = runTest(dispatcher) {
        val source = FakeDelegationSource(error = HttpException(404, "getDelegations"))
        val vm = DelegationManagementViewModel(source)
        advanceUntilIdle()
        val s = vm.state.value
        assertTrue(s is DelegationListUiState.Error)
        assertTrue((s as DelegationListUiState.Error).message.contains("404"))
    }

    @Test
    fun `revoke success flips row to revoked and clears revokingId`() = runTest(dispatcher) {
        val source = FakeDelegationSource(
            response = DelegationsResponse(
                granted = listOf(sample("d2", revoked = 0)),
                received = emptyList(),
            )
        )
        val vm = DelegationManagementViewModel(source)
        advanceUntilIdle()
        vm.revoke("d2")
        advanceUntilIdle()
        val s = vm.state.value as DelegationListUiState.Loaded
        assertEquals(true, s.granted.first().isRevoked)
        assertNull(s.revokingId)
        assertNull(s.revokeError)
    }

    @Test
    fun `revoke failure leaves row untouched and surfaces revokeError`() = runTest(dispatcher) {
        val source = FakeDelegationSource(
            response = DelegationsResponse(
                granted = listOf(sample("d3", revoked = 0)),
                received = emptyList(),
            ),
            revokeError = HttpException(500, "revokeDelegation"),
        )
        val vm = DelegationManagementViewModel(source)
        advanceUntilIdle()
        vm.revoke("d3")
        advanceUntilIdle()
        val s = vm.state.value as DelegationListUiState.Loaded
        assertEquals(false, s.granted.first().isRevoked)
        assertNotNull(s.revokeError)
        assertNull(s.revokingId)
    }

    @Test
    fun `revoke against non-Loaded state is a no-op`() = runTest(dispatcher) {
        val source = FakeDelegationSource(error = HttpException(500, "getDelegations"))
        val vm = DelegationManagementViewModel(source)
        advanceUntilIdle()
        vm.revoke("d-unknown")
        advanceUntilIdle()
        // Still in Error state — revoke did not transition.
        assertTrue(vm.state.value is DelegationListUiState.Error)
    }

    @Test
    fun `revoke success on non-revoking server response surfaces Server rejected revoke`() = runTest(dispatcher) {
        val source = FakeDelegationSource(
            response = DelegationsResponse(
                granted = listOf(sample("d4", revoked = 0)),
                received = emptyList(),
            ),
            revokeOk = false,
        )
        val vm = DelegationManagementViewModel(source)
        advanceUntilIdle()
        vm.revoke("d4")
        advanceUntilIdle()
        val s = vm.state.value as DelegationListUiState.Loaded
        assertEquals(false, s.granted.first().isRevoked)
        assertNotNull(s.revokeError)
        assertTrue(s.revokeError!!.contains("rejected"))
    }
}

private fun sample(id: String, revoked: Int) = DelegationGranted(
    delegation_id = id,
    peer_verify_key = "ed25519:peer_key_$id",
    peer_hub_name = "peer-$id",
    plugin = "google-calendar",
    tool = "listEvents",
    scope = "calendar:read",
    expires_at = "2026-12-31T00:00:00Z",
    revoked = revoked,
    created_at = "2026-09-01T00:00:00Z",
)

private class FakeDelegationSource(
    var response: DelegationsResponse = DelegationsResponse(),
    var error: Throwable? = null,
    var revokeOk: Boolean = true,
    var revokeError: Throwable? = null,
) : DelegationSource {

    override suspend fun getDelegations(): DelegationsResponse {
        error?.let { throw it }
        return response
    }

    override suspend fun revokeDelegation(delegationId: String): Boolean {
        revokeError?.let { throw it }
        return revokeOk
    }
}
