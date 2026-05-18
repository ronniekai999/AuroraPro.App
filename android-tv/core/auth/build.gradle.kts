plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

android {
    namespace = "io.aurora.tv.core.auth"
    compileSdk = 35
    defaultConfig { minSdk = 28 }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":core:design"))
    implementation(project(":core:ui"))
    implementation(project(":core:network"))

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.animation)
    implementation(libs.compose.tv.foundation)
    implementation(libs.compose.tv.material)
    implementation(libs.compose.material.icons.extended)

    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)

    implementation(libs.hilt.android)
    implementation(libs.hilt.navigation.compose)
    ksp(libs.hilt.compiler)

    implementation(libs.datastore.preferences)
    implementation(libs.security.crypto)
    implementation(libs.kotlin.serialization.json)
    implementation(libs.kotlin.coroutines.core)

    // Retrofit + OkHttp — AuroraApiProvider builds per-server Retrofit instances
    // here using the OkHttpClient + Json singletons exposed by :core:network.
    // The auth module owns the Retrofit lifecycle because the base URL comes
    // from sign-in, and the auth interceptor needs AuthTokenStore.
    //
    // `api(libs.retrofit)` rather than `implementation` because feature
    // repositories that consume AuroraApiProvider need to catch
    // `retrofit2.HttpException` — that's part of the public error
    // contract, not an internal detail. Exposing it transitively lets
    // every future feature module skip its own Retrofit dep.
    api(libs.retrofit)
    implementation(libs.retrofit.kotlinx.serialization)
    implementation(libs.okhttp)

    debugImplementation(libs.compose.ui.tooling)
}
