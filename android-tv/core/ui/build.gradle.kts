plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    // Required because core:ui defines @Serializable types (MediaItem) that
    // are then composed into other @Serializable types in feature modules
    // (HomeRow). The serialization compiler plugin has to run in the module
    // that DEFINES the @Serializable type — without it, no serializer is
    // generated, and downstream modules can't serialize fields of that type.
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "io.aurora.tv.core.ui"
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
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.animation)
    implementation(libs.compose.tv.foundation)
    implementation(libs.compose.tv.material)
    implementation(libs.compose.material.icons.extended)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    // Runtime support for the @Serializable types this module defines.
    implementation(libs.kotlin.serialization.json)
    debugImplementation(libs.compose.ui.tooling)
}
