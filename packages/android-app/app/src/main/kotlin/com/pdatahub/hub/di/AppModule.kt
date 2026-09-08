package com.pdatahub.hub.di

import com.pdatahub.hub.mcp.DelegationSource
import com.pdatahub.hub.mcp.HubCoreApi
import com.pdatahub.hub.mcp.HubIdentitySource
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.OkHttpClient
import javax.inject.Singleton

/**
 * Hilt module for app-wide bindings.
 *
 * Most classes are wired via @Inject constructors and don't need explicit
 * @Provides methods. This module provides cross-cutting singletons like
 * OkHttpClient used by both Cloudflare Relay client and the Hub-core
 * Approval WebSocket client.
 */
@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideOkHttpClient(): OkHttpClient = OkHttpClient.Builder().build()

    @Provides
    @Singleton
    fun provideHubIdentitySource(api: HubCoreApi): HubIdentitySource = api

    @Provides
    @Singleton
    fun provideDelegationSource(api: HubCoreApi): DelegationSource = api
}
