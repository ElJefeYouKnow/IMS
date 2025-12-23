import React, { useState, useEffect } from 'react';
import { SafeAreaView, View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator } from 'react-native';
import { login, fetchMetrics, fetchLowStock, fetchRecentActivity } from './api';

const FALLBACK_USER = null;

export default function App(){
  const [user, setUser] = useState(FALLBACK_USER);
  return (
    <SafeAreaView style={styles.container}>
      {!user ? <LoginScreen onLogin={setUser} /> : <Dashboard user={user} onLogout={()=>setUser(null)} />}
    </SafeAreaView>
  );
}

function LoginScreen({ onLogin }){
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);
  const handleLogin=async()=>{
    setError('');
    setLoading(true);
    try{
      const u = await login(email.trim(), password);
      onLogin(u);
    }catch(e){
      setError(e.message||'Login failed');
    }finally{
      setLoading(false);
    }
  };
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Sign in</Text>
      <TextInput placeholder="Email" autoCapitalize="none" style={styles.input} value={email} onChangeText={setEmail} />
      <TextInput placeholder="Password" secureTextEntry style={styles.input} value={password} onChangeText={setPassword} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TouchableOpacity style={styles.button} onPress={handleLogin} disabled={loading}>
        <Text style={styles.buttonText}>{loading ? 'Signing in...' : 'Login'}</Text>
      </TouchableOpacity>
    </View>
  );
}

function Dashboard({ user, onLogout }){
  const [metrics,setMetrics]=useState(null);
  const [lowStock,setLowStock]=useState([]);
  const [activity,setActivity]=useState([]);
  const [loading,setLoading]=useState(true);
  const [now,setNow]=useState(new Date());
  const isAdmin = user.role === 'admin';
  useEffect(()=>{
    let mounted=true;
    (async ()=>{
      try{
        const [m, low, act] = await Promise.all([
          fetchMetrics(user),
          fetchLowStock(user),
          fetchRecentActivity(user, 8)
        ]);
        if(!mounted) return;
        setMetrics(m);
        setLowStock(low||[]);
        setActivity(act||[]);
      }catch(e){
        console.warn('Dashboard load failed', e);
      }finally{
        if(mounted) setLoading(false);
      }
    })();
    return ()=>{mounted=false;};
  },[user]);
  useEffect(()=>{
    const id = setInterval(()=>setNow(new Date()), 1000);
    return ()=>clearInterval(id);
  },[]);
  if(loading) return <ActivityIndicator style={{marginTop:40}} />;
  return (
    <View style={{flex:1}}>
      <View style={styles.topRow}>
        <Text style={styles.title}>{isAdmin ? 'Admin' : 'Employee'} Dashboard</Text>
        <View style={styles.topRight}>
          <View style={styles.clockPill}>
            <Text style={styles.clockLabel}>Now</Text>
            <Text style={styles.clock}>{now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</Text>
          </View>
          <TouchableOpacity style={styles.logoutBtn} onPress={onLogout}>
            <Text style={styles.logoutText}>Logout</Text>
          </TouchableOpacity>
        </View>
      </View>
      {metrics && (
        <View style={styles.metricsRow}>
          <Metric label="Available" value={metrics.availableUnits}/>
          <Metric label="Reserved" value={metrics.reservedUnits}/>
          <Metric label="Low Stock" value={metrics.lowStockCount}/>
          {isAdmin && <Metric label="Active Jobs" value={metrics.activeJobs}/>}
        </View>
      )}
      <Text style={styles.subtitle}>Low Stock</Text>
      <FlatList
        data={lowStock}
        keyExtractor={(item)=>item.code}
        renderItem={({item})=>(
          <View style={styles.listRow}>
            <Text style={styles.listCode}>{item.code}</Text>
            <Text style={styles.listText}>{item.name}</Text>
            <Text style={styles.listBadge}>Avail: {item.available}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.muted}>No low stock items</Text>}
      />
      <Text style={styles.subtitle}>Recent Activity</Text>
      <FlatList
        data={activity}
        keyExtractor={(item)=>item.id||`${item.code}-${item.ts}`}
        renderItem={({item})=>(
          <View style={styles.listRow}>
            <Text style={styles.listCode}>{item.type}</Text>
            <Text style={styles.listText}>{item.code} x {item.qty}</Text>
            <Text style={styles.muted}>{item.jobId||'No job'}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.muted}>No activity</Text>}
      />
    </View>
  );
}

function Metric({label,value}){
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value ?? 'N/A'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container:{flex:1,padding:16,backgroundColor:'#0b1020'},
  card:{backgroundColor:'#111827',padding:16,borderRadius:12},
  title:{fontSize:22,fontWeight:'700',color:'#fff',marginBottom:12},
  topRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:12},
  topRight:{flexDirection:'row',alignItems:'center',gap:10},
  clockPill:{flexDirection:'row',alignItems:'center',gap:6,backgroundColor:'#111827',paddingVertical:6,paddingHorizontal:10,borderRadius:10,borderWidth:1,borderColor:'#1f2937'},
  clockLabel:{color:'#9ca3af',fontSize:11,fontWeight:'700',letterSpacing:0.5,textTransform:'uppercase'},
  clock:{color:'#e5e7eb',fontWeight:'800',fontSize:16},
  logoutBtn:{paddingVertical:8,paddingHorizontal:12,borderRadius:8,borderWidth:1,borderColor:'#374151',backgroundColor:'#111827'},
  logoutText:{color:'#fca5a5',fontWeight:'700'},
  subtitle:{fontSize:18,fontWeight:'600',color:'#cbd5f5',marginTop:16,marginBottom:6},
  input:{backgroundColor:'#1f2937',color:'#fff',padding:12,borderRadius:8,marginBottom:10},
  button:{backgroundColor:'#4f46e5',padding:14,borderRadius:10,alignItems:'center'},
  buttonText:{color:'#fff',fontWeight:'700'},
  error:{color:'#f87171',marginBottom:8},
  metricsRow:{flexDirection:'row',flexWrap:'wrap',gap:8,marginBottom:8},
  metricCard:{backgroundColor:'#1f2937',padding:12,borderRadius:8,minWidth:120},
  metricLabel:{color:'#cbd5f5',fontSize:12},
  metricValue:{color:'#fff',fontSize:18,fontWeight:'700'},
  listRow:{backgroundColor:'#111827',padding:10,borderRadius:8,marginBottom:6},
  listCode:{color:'#cbd5f5',fontWeight:'700'},
  listText:{color:'#fff'},
  listBadge:{color:'#fcd34d',fontWeight:'700'},
  muted:{color:'#9ca3af'}
});
