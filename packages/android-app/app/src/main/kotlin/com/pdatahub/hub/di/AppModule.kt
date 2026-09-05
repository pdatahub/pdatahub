package com.pdatahub.hub.di

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
}
