package com.pdatahub.hub.ui.identity

import com.pdatahub.hub.mcp.DelegationSource
import com.pdatahub.hub.mcp.DelegationsResponse
import com.pdatahub.hub.mcp.HttpException
import com.pdatahub.hub.mcp.HubIdentitySource
import com.pdatahub.hub.mcp.IdentityResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HubIdentityViewModelTest {

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
    fun `init refresh loads identity into Loaded state`() = runTest(dispatcher) {
        val source = FakeHubIdentitySource(
            identityResult = IdentityResponse(
                verify_key = "ed25519:abc_test_key",
                hub_name = "userA",
                magic_dns = "userA.tail36274d.ts.net",
                fingerprint = "AB CD EF 01 23 45 67 89",
            )
        )
        val vm = HubIdentityViewModel(source)
        advanceUntilIdle()
        val state = vm.state.value
        assertTrue("expected Loaded, got $state", state is HubIdentityUiState.Loaded)
        val loaded = state as HubIdentityUiState.Loaded
        assertEquals("userA", loaded.identity.hub_name)
        assertEquals("userA.tail36274d.ts.net", loaded.identity.magic_dns)
        assertEquals("AB CD EF 01 23 45 67 89", loaded.identity.fingerprint)
    }

    @Test
    fun `init refresh transitions through Loading immediately`() = runTest(dispatcher) {
        val source = FakeHubIdentitySource(
            identityResult = IdentityResponse(
                verify_key = "ed25519:abc",
                hub_name = "userA",
                magic_dns = null,
                fingerprint = "00 00 00 00 00 00 00 00",
            )
        )
        val vm = HubIdentityViewModel(source)
        val intermediate = vm.state.value
        assertTrue(
            "expected Loading immediately after construction, got $intermediate",
            intermediate is HubIdentityUiState.Loading,
        )
    }

    @Test
    fun `init refresh failure surfaces Error state`() = runTest(dispatcher) {
        val source = FakeHubIdentitySource(identityError = HttpException(500, "getIdentity"))
        val vm = HubIdentityViewModel(source)
        advanceUntilIdle()
        val state = vm.state.value
        assertTrue("expected Error, got $state", state is HubIdentityUiState.Error)
        assertTrue(
            "error must mention the failing op",
            (state as HubIdentityUiState.Error).message.contains("500"),
        )
    }

    @Test
    fun `refresh after Error recovers to Loaded`() = runTest(dispatcher) {
        val source = FakeHubIdentitySource(identityError = HttpException(500, "getIdentity"))
        val vm = HubIdentityViewModel(source)
        advanceUntilIdle()
        assertTrue(vm.state.value is HubIdentityUiState.Error)

        source.setIdentityResult(
            IdentityResponse(
                verify_key = "ed25519:recovered",
                hub_name = "userA",
                magic_dns = "userA.tail36274d.ts.net",
                fingerprint = "FF FF FF FF FF FF FF FF",
            )
        )
        vm.refresh()
        advanceUntilIdle()
        val state = vm.state.value
        assertTrue("expected Loaded after recovery, got $state", state is HubIdentityUiState.Loaded)
    }
}

private class FakeHubIdentitySource(
    private var identityResult: IdentityResponse? = null,
    private var identityError: Throwable? = null,
) : HubIdentitySource {
    fun setIdentityResult(value: IdentityResponse) {
        identityResult = value
        identityError = null
    }

    override suspend fun getIdentity(): IdentityResponse {
        identityError?.let { throw it }
        return requireNotNull(identityResult) { "identityResult not set" }
    }
}
