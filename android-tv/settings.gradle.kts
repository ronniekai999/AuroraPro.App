pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "aurora-tv"

include(":app")

include(":core:design")
include(":core:ui")
include(":core:auth")
include(":core:network")
include(":core:database")
include(":core:media")

include(":feature:profiles")
include(":feature:home")
include(":feature:detail")
include(":feature:movies")
include(":feature:shows")
include(":feature:search")
include(":feature:watchparty")
include(":feature:settings")
include(":feature:account")
