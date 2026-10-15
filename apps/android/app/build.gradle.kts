import java.util.Properties

plugins {
    id("com.android.application")
    kotlin("android")
    kotlin("plugin.compose")
}

fun prop(name: String): String = providers.gradleProperty(name).get()

// Release signing. Values come from apps/android/keystore.properties
// (git-ignored, for local builds) or from ALFAJER_* environment variables
// (CI). No signing material ever lives in the repository. Without them the
// release build is produced unsigned, as before.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.isFile) f.inputStream().use(::load)
}

fun signing(key: String, env: String): String? =
    keystoreProps.getProperty(key)?.takeIf { it.isNotBlank() } ?: System.getenv(env)?.takeIf { it.isNotBlank() }

val releaseStoreFile = signing("storeFile", "ALFAJER_KEYSTORE_FILE")

val webUrl = prop("alfajer.webUrl").trimEnd('/')

android {
    namespace = "com.alaobeidat.alfajer"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.alaobeidat.alfajer"
        minSdk = 26
        targetSdk = 35
        versionCode = prop("alfajer.versionCode").toInt()
        versionName = prop("alfajer.versionName")

        buildConfigField("String", "SIGNALING_URL", "\"${prop("alfajer.signalingUrl")}\"")
        buildConfigField("String", "WEB_URL", "\"$webUrl\"")
        buildConfigField("String", "TURN_URLS", "\"${prop("alfajer.turnUrls")}\"")
        // Host for the https://<host>/call/<code> deep link.
        manifestPlaceholders["webHost"] = webUrl.substringAfter("://").substringBefore('/')
    }

    signingConfigs {
        if (releaseStoreFile != null) {
            create("release") {
                storeFile = rootProject.file(releaseStoreFile)
                storePassword = signing("storePassword", "ALFAJER_KEYSTORE_PASSWORD")
                keyAlias = signing("keyAlias", "ALFAJER_KEY_ALIAS")
                keyPassword = signing("keyPassword", "ALFAJER_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            // Allows a local ws://10.0.2.2:3000 signaling server in dev builds.
            manifestPlaceholders["usesCleartext"] = "true"
        }
        release {
            manifestPlaceholders["usesCleartext"] = "false"
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation(project(":core"))

    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.core:core-ktx:1.15.0")

    implementation("io.getstream:stream-webrtc-android:1.3.10")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
