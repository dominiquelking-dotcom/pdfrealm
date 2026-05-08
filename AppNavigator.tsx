import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Text } from 'react-native';

import HomeScreen from '../screens/HomeScreen';
import ToolsListScreen from '../screens/ToolsListScreen';
import ToolScreen from '../screens/ToolScreen';
import VaultScreen from '../screens/VaultScreen';
import SignRequestScreen from '../screens/SignRequestScreen';
import AIOperatorScreen from '../screens/AIOperatorScreen';
import AIChatScreen from '../screens/AIChatScreen';

const Tab = createBottomTabNavigator();
const HomeStack = createNativeStackNavigator();
const ToolsStack = createNativeStackNavigator();

function HomeStackNav() {
  return (
    <HomeStack.Navigator screenOptions={{ headerShown: false }}>
      <HomeStack.Screen name="HomeMain" component={HomeScreen} />
    </HomeStack.Navigator>
  );
}

function ToolsStackNav() {
  return (
    <ToolsStack.Navigator screenOptions={{ headerShown: false }}>
      <ToolsStack.Screen name="ToolsList" component={ToolsListScreen} />
      <ToolsStack.Screen name="ToolDetail" component={ToolScreen} />
    </ToolsStack.Navigator>
  );
}

function TabIcon({ emoji }: { emoji: string }) {
  return <Text style={{ fontSize: 22 }}>{emoji}</Text>;
}

export default function AppNavigator() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: '#1e40af',
          tabBarInactiveTintColor: '#94a3b8',
          tabBarStyle: {
            backgroundColor: '#fff',
            borderTopColor: '#e2e8f0',
            height: 62,
            paddingBottom: 8,
          },
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: '600',
          },
        }}
      >
        <Tab.Screen
          name="Home"
          component={HomeStackNav}
          options={{
            tabBarIcon: () => <TabIcon emoji="🏠" />,
          }}
        />
        <Tab.Screen
          name="Tools"
          component={ToolsStackNav}
          options={{
            tabBarIcon: () => <TabIcon emoji="🔧" />,
          }}
        />
        <Tab.Screen
          name="Vault"
          component={VaultScreen}
          options={{
            tabBarIcon: () => <TabIcon emoji="🗄️" />,
          }}
        />
        <Tab.Screen
          name="Sign"
          component={SignRequestScreen}
          options={{
            tabBarIcon: () => <TabIcon emoji="✍️" />,
          }}
        />
        <Tab.Screen
          name="AI"
          component={AIOperatorScreen}
          options={{
            tabBarLabel: 'AI',
            tabBarIcon: () => <TabIcon emoji="🤖" />,
          }}
        />
        <Tab.Screen
          name="AIChat"
          component={AIChatScreen}
          options={{
            tabBarLabel: 'AI Chat',
            tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>✨</Text>,
          }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
