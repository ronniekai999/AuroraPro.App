plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

android {
    namespace = "io.aurora.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.aurora.tv"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-alpha"
    }

    buildFeatures { compose = true }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isDebuggable = true
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "META-INF/LICENSE*",
            "META-INF/NOTICE*",
        )
    }
}

dependencies {
    implementation(project(":core:design"))
    implementation(project(":core:ui"))
    implementation(project(":core:auth"))
    implementation(project(":core:network"))
    implementation(project(":core:media"))
    implementation(project(":feature:profiles"))
    implementation(project(":feature:home"))
    implementation(project(":feature:detail"))
    implementation(project(":feature:movies"))
    implementation(project(":feature:shows"))
    implementation(project(":feature:search"))
    implementation(project(":feature:watchparty"))
    implementation(project(":feature:settings"))
    implementation(project(":feature:account"))

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.animation)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.tv.foundation)
    implementation(libs.compose.tv.material)

    implementation(libs.activity.compose)
    implementation(libs.navigation.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.core.ktx)

    implementation(libs.hilt.android)
    implementation(libs.hilt.navigation.compose)
    ksp(libs.hilt.compiler)

    debugImplementation(libs.compose.ui.tooling)

    // Coil 3 — the Application class implements SingletonImageLoader.Factory
    // and explicitly registers OkHttpNetworkFetcherFactory. Without this, Coil
    // 3's ServiceLoader-based auto-discovery is unreliable (especially under
    // R8/ProGuard or with complex transitive dep graphs) and image requests
    // can silently fail to even fire. Explicit registration makes the network
    // path deterministic. :feature:home gets coil via its own implementation
    // dep; this exposes Coil types to the :app compile classpath specifically
    // for the Application-level config.
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)

    // The nav graph encodes/decodes MediaItem JSON across the home → detail
    // boundary. The serialization plugin is applied above; this is the
    // runtime library that backs the generated serializers.
    implementation(libs.kotlin.serialization.json)
}
